import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdtemp, rm, readdir, stat, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateDeck, parseDeck, makeSlide, reviewDeck, MAX_BYTES, LAYOUTS } from '../public/model.js';
import { renderSlide, exportHTML, escapeHTML } from '../public/render.js';
import { sampleDeck } from '../lib/sample.js';
import { createApp, ROOT, atomicWrite } from '../server.js';
const run = promisify(execFile);
const css = await readFile(resolve(ROOT, 'public/slide.css'), 'utf8');
const js = await readFile(resolve(ROOT, 'public/presentation.js'), 'utf8');
const clone = () => sampleDeck();
const minimal = () => ({ version: 1, id: 'deck', title: 'A decision', slides: [{ id: 's1', layout: 'title' }] });

function raw(port, { path = '/', method = 'GET', headers = {}, body } = {}) {
  return new Promise((accept, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => accept({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) })); });
    req.on('error', reject); if (body !== undefined) req.write(body); req.end();
  });
}
async function fixture(t) {
  const directory = await mkdtemp(resolve(ROOT, 'test/run-'));
  const dataFile = resolve(directory, 'deck.json');
  const server = await createApp({ dataFile });
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const port = server.address().port;
  t.after(async () => { await new Promise(accept => server.close(accept)); await rm(directory, { recursive: true, force: true }); });
  const send = async (deck, revision, extra = {}) => raw(port, { method: 'PUT', path: '/api/deck', body: typeof deck === 'string' ? deck : JSON.stringify(deck), headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json', ...(revision ? { 'If-Match': revision } : {}), ...extra } });
  return { directory, dataFile: resolve(directory, 'workspace.json'), server, port, send };
}

test('sample is fictional, schema-valid and covers every layout', () => {
  const deck = clone(); assert.deepEqual(validateDeck(deck), deck); assert.deepEqual(deck.slides.map(s => s.layout), LAYOUTS);
  assert.match(deck.slides[0].source, /Fictional/); assert.equal(reviewDeck(deck).length, 0);
  assert.ok(deck.slides.every(s => s.label !== 'evidence'));
});
test('normalization fills optional fields without changing input', () => {
  const input = minimal(), deck = validateDeck(input); assert.equal(deck.theme, 'navy'); assert.equal(deck.slides[0].label, 'assumption');
  assert.deepEqual(deck.slides[0].points, []); assert.equal(input.theme, undefined);
});
test('all new layouts create independent unique slide IDs', () => {
  const slides = LAYOUTS.map(makeSlide); assert.equal(new Set(slides.map(s => s.id)).size, slides.length);
  for (const s of slides) assert.doesNotThrow(() => validateDeck({ ...minimal(), slides: [s] }));
});
test('reject invalid roots, versions, IDs, layouts, themes and empty decks', () => {
  for (const root of [null, [], 'deck', 1]) assert.throws(() => validateDeck(root));
  for (const patch of [{ version: 2 }, { id: '../secrets' }, { theme: 'url(javascript:)' }, { title: '  ' }, { slides: [] }]) assert.throws(() => validateDeck({ ...minimal(), ...patch }));
  const d = clone(); d.slides[0].layout = 'html'; assert.throws(() => validateDeck(d), /expected/);
  d.slides[0].layout = 'title'; d.slides[1].id = d.slides[0].id; assert.throws(() => validateDeck(d), /duplicate/);
});
test('reject unknown and prototype-poisoning fields at every schema level', () => {
  for (const key of ['__proto__', 'constructor', 'prototype', 'html', 'script']) {
    const d = minimal(); Object.defineProperty(d, key, { value: { polluted: true }, enumerable: true }); assert.throws(() => parseDeck(JSON.stringify(d)), /unknown field/);
    const nested = clone(); Object.defineProperty(nested.slides[1].points[0], key, { value: 'payload', enumerable: true }); assert.throws(() => validateDeck(nested), /unknown field/);
  }
  assert.equal({}.polluted, undefined);
});
test('field and array limits reject oversized input', () => {
  const d = clone(); d.slides[0].title = 'x'.repeat(141); assert.throws(() => validateDeck(d), /140/);
  d.slides[0].title = 'Valid'; d.slides[0].notes = 'x'.repeat(8001); assert.throws(() => validateDeck(d), /8000/);
  d.slides[0].notes = ''; d.slides = Array.from({ length: 31 }, (_, i) => ({ ...d.slides[0], id: `s${i}` })); assert.throws(() => validateDeck(d), /1–30/);
  const rows = clone(); rows.slides[1].points = Array.from({ length: 7 }, () => ({ text: 'x' })); assert.throws(() => validateDeck(rows), /at most 6/);
});
test('import rejects malformed, huge, control and nontext values', () => {
  assert.throws(() => parseDeck('{bad json'), /invalid JSON/); assert.throws(() => parseDeck('x'.repeat(MAX_BYTES + 1)), /1 MiB/);
  assert.throws(() => parseDeck('é'.repeat(MAX_BYTES)), /1 MiB/);
  for (const title of [false, 123, {}, null, '\u0000']) assert.throws(() => validateDeck({ ...minimal(), title }));
});
test('normalized disk representation cannot exceed import byte limit', () => {
  const d = clone(); d.slides = Array.from({ length: 30 }, (_, i) => ({ ...makeSlide('findings'), id: `s${i}`, notes: '界'.repeat(8000), points: Array.from({ length: 6 }, () => ({ text: '界'.repeat(400), labelType: 'assumption', source: '界'.repeat(400) })) }));
  assert.throws(() => validateDeck(d), /1 MiB/);
});
test('QA identifies provenance, missing actions, empty titles and heuristic density', () => {
  const d = clone(); d.slides.pop(); d.slides[1].title = ''; d.slides[1].label = 'evidence'; d.slides[1].source = ''; d.slides[1].points = [{ text: 'word '.repeat(75), labelType: 'evidence', source: '' }, { text: 'word '.repeat(75), labelType: 'assumption', source: '' }];
  const issues = reviewDeck(d); for (const code of ['next-steps', 'title', 'source', 'density']) assert.ok(issues.some(i => i.code === code), code);
  assert.match(issues.find(i => i.code === 'density').message, /not a measured overflow test/);
});
test('QA excludes private notes and inactive layout text from density', () => {
  const d = clone(); d.slides[0].notes = 'word '.repeat(1500); d.slides[0].points = Array.from({ length: 6 }, () => ({ text: 'word '.repeat(75), source: '', labelType: 'assumption' }));
  assert.ok(!reviewDeck(d).some(i => i.code === 'density' && i.slideId === d.slides[0].id));
  const action = d.slides.at(-1).actions[0]; action.owner = ''; action.date = ''; assert.ok(reviewDeck(d).some(i => i.code === 'ownership'));
});
test('renderer escapes hostile text in every layout and attributes', () => {
  const attack = '</script><img src=x onerror="alert(1)">&\'';
  assert.equal(escapeHTML('<&>"\''), '&lt;&amp;&gt;&quot;&#39;');
  for (const s of clone().slides) {
    s.title = attack; s.subtitle = attack; s.source = attack;
    for (const key of ['points', 'nodes', 'columns', 'metrics', 'actions']) for (const row of s[key]) for (const field of Object.keys(row)) if (field !== 'labelType') row[field] = attack;
    const html = renderSlide(s, 0, 1, 'navy'); assert.ok(!html.includes('<img')); assert.ok(!html.includes('</script>')); assert.ok(html.includes('&lt;img')); assert.ok(!html.includes('aria-label="Slide 1: </'));
  }
});
test('offline export is self contained, escaped, and excludes notes/inactive data', () => {
  const d = clone(); d.title = '</title><script>bad()</script>'; d.slides[0].notes = 'PRIVATE_NOTE_SENTINEL'; d.slides[0].points = [{ text: 'INACTIVE_SENTINEL', source: '', labelType: 'assumption' }];
  const html = exportHTML(d, css, js); assert.ok(!html.includes('PRIVATE_NOTE_SENTINEL')); assert.ok(!html.includes('INACTIVE_SENTINEL'));
  assert.ok(!html.includes('<script>bad()')); assert.equal((html.match(/class="export-slide"/g) || []).length, 6);
  assert.match(html, /connect-src 'none'/); assert.ok(!/<(?:script|link|img)[^>]+(?:src|href)=/.test(html));
  assert.match(html, /@media print/); assert.match(html, /ArrowRight/); assert.match(html, /window.print/);
});
test('HTML export validates the deck rather than interpolating unknown layouts', () => {
  const d = clone(); d.slides[0].layout = 'x" onclick="alert(1)'; assert.throws(() => exportHTML(d, css, js));
});
test('skill templates import successfully and metadata references the skill', async () => {
  const names = ['fde-discovery-narrative', 'fde-technical-architecture', 'fde-pilot-readout', 'fde-deck-review'];
  for (const name of names) {
    const root = resolve(ROOT, 'skills', name); const template = parseDeck(await readFile(resolve(root, 'assets/template.json'), 'utf8'));
    assert.ok(template.slides.length >= 4); const skill = await readFile(resolve(root, 'SKILL.md'), 'utf8'); assert.ok(skill.includes('untrusted')); assert.ok(skill.includes('references/fielddeck-format.txt'));
    const yaml = await readFile(resolve(root, 'agents/openai.yaml'), 'utf8'); assert.ok(yaml.includes(`$${name}`));
    const evaluations = JSON.parse(await readFile(resolve(root, 'assets/eval-prompts.json'), 'utf8')); assert.equal(evaluations.cases.length, 3);
  }
});
test('atomic persistence writes private files without leaving temporary files', async t => {
  const directory = await mkdtemp(resolve(ROOT, 'test/atomic-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = resolve(directory, 'deck.json'); await atomicWrite(file, clone()); await atomicWrite(file, { ...clone(), title: 'New title' });
  assert.equal(parseDeck(await readFile(file, 'utf8')).title, 'New title'); assert.deepEqual(await readdir(directory), ['deck.json']); assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test('server serves local app with restrictive headers and no traversal', async t => {
  const { port, server } = await fixture(t); assert.equal(server.address().address, '127.0.0.1');
  const home = await raw(port); assert.equal(home.status, 200); assert.match(home.text, /Fielddeck/); assert.match(home.headers['content-security-policy'], /script-src 'self'/); assert.ok(!home.headers['content-security-policy'].includes('unsafe-inline')); assert.equal(home.headers['x-content-type-options'], 'nosniff');
  for (const path of ['/server.js', '/data/deck.json', '/../server.js', '/%2e%2e/server.js', '/%2fetc/passwd', '/missing']) assert.equal((await raw(port, { path })).status, 404, path);
  assert.equal((await raw(port, { method: 'HEAD' })).text, '');
});
test('Host, Origin, fetch-site and method checks reject untrusted requests', async t => {
  const { port } = await fixture(t);
  for (const headers of [{ Host: 'attacker.example' }, { Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await raw(port, { headers })).status, 403);
  assert.equal((await raw(port, { headers: { Host: `localhost:${port}` } })).status, 200);
  assert.equal((await raw(port, { method: 'POST' })).status, 405);
  assert.equal((await raw(port, { path: '//evil.example/' })).status, 400);
});
test('save requires same-origin JSON and optimistic concurrency', async t => {
  const { port, send, dataFile } = await fixture(t);
  const initial = (await raw(port, { path: '/api/deck' })).json(); const next = { ...initial.deck, title: 'Saved from test' };
  assert.equal((await send(next, initial.revision, { Origin: '' })).status, 403);
  assert.equal((await send(next, initial.revision, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await send(next)).status, 428);
  const save = await send(next, initial.revision); assert.equal(save.status, 200); assert.notEqual(save.json().revision, initial.revision);
  assert.equal(JSON.parse(await readFile(dataFile, 'utf8')).decks[0].deck.title, next.title);
  assert.equal((await send({ ...next, title: 'Stale write' }, initial.revision)).status, 409);
  assert.equal((await raw(port, { path: '/api/deck' })).json().deck.title, next.title);
});
test('simultaneous writers cannot both overwrite one revision', async t => {
  const { port, send } = await fixture(t); const initial = (await raw(port, { path: '/api/deck' })).json();
  const responses = await Promise.all([send({ ...initial.deck, title: 'A' }, initial.revision), send({ ...initial.deck, title: 'B' }, initial.revision)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
});
test('unsafe or oversized imports leave prior saved deck intact', async t => {
  const { port, send, dataFile } = await fixture(t); const initial = (await raw(port, { path: '/api/deck' })).json(); const original = await readFile(dataFile, 'utf8');
  for (const body of ['{bad', '{"__proto__":{"polluted":true}}', JSON.stringify({ ...initial.deck, slides: [] })]) assert.equal((await send(body, initial.revision)).status, 400);
  assert.equal((await send('x'.repeat(MAX_BYTES + 1), initial.revision)).status, 413);
  assert.equal((await send(initial.deck, initial.revision, { 'Content-Encoding': 'gzip' })).status, 415);
  assert.equal(await readFile(dataFile, 'utf8'), original);
});
test('stored hostile strings remain inert in served offline export', async t => {
  const { port, send } = await fixture(t); const initial = (await raw(port, { path: '/api/deck' })).json(); initial.deck.slides[0].title = '<script>alert(1)</script>'; initial.deck.slides[0].notes = 'PRIVATE_SERVER_NOTE';
  assert.equal((await send(initial.deck, initial.revision)).status, 200);
  const output = await raw(port, { path: '/api/export/html' }); assert.equal(output.status, 200); assert.match(output.headers['content-disposition'], /attachment/); assert.match(output.headers['content-security-policy'], /sha256-/); assert.ok(!output.text.includes('<script>alert(1)')); assert.ok(!output.text.includes('PRIVATE_SERVER_NOTE'));
});
test('corrupt saved decks fail closed and are never silently replaced', async t => {
  const directory = await mkdtemp(resolve(ROOT, 'test/corrupt-')); t.after(() => rm(directory, { recursive: true, force: true })); const file = resolve(directory, 'deck.json'); await writeFile(file, 'CORRUPT');
  await assert.rejects(createApp({ dataFile: file }), /preserved/); assert.equal(await readFile(file, 'utf8'), 'CORRUPT');
});
test('storage rejects outside paths and symlink escapes', async t => {
  await assert.rejects(createApp({ dataFile: '/tmp/fielddeck-forbidden.json' }), /within/);
  const directory = await mkdtemp(resolve(ROOT, 'test/symlink-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await symlink('/tmp', resolve(directory, 'escape')); await assert.rejects(createApp({ dataFile: resolve(directory, 'escape/deck.json') }), /within/);
});
test('configurable dataDir accepts the approved symlink path', async t => {
  const directory = await mkdtemp('/home/jun.ong/Sideproject/fielddeck/test/run-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await createApp({ dataDir: directory });
  assert.equal(JSON.parse(await readFile(resolve(directory, 'workspace.json'), 'utf8')).decks[0].deck.slides.length, 6);
  await assert.rejects(readFile(resolve(directory, 'deck.json')), { code: 'ENOENT' });
  server.close();
});
test('CLI help works through the requested /home path and invalid flags fail', async () => {
  const { stdout } = await run(process.execPath, ['/home/jun.ong/Sideproject/fielddeck/server.js', '--help']); assert.match(stdout, /127.0.0.1:4311/); assert.match(stdout, /npm test/);
  await assert.rejects(run(process.execPath, [resolve(ROOT, 'server.js'), '--host', '0.0.0.0']), error => error.code === 1 && /Invalid arguments/.test(error.stderr));
});
