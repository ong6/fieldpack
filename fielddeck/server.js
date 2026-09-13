#!/usr/bin/env node
import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { validateDeck, parseDeck, validateBrief, ValidationError, MAX_BYTES, SKILLS, STARTERS } from './public/model.js';
import { exportHTML } from './public/render.js';
import { sampleDeck } from './lib/sample.js';
import { atomicWrite, revisionOf, entryRevision, openWorkspace, preserveLegacy, regularFile, validateWorkspace, WORKSPACE_LIMITS, strictObject, boundedText, problem, detail, newEntry, metadata } from './lib/workspace.js';
import { briefBundle, skillFiles } from './lib/zip.js';
export { atomicWrite, revisionOf } from './lib/workspace.js';
export const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(ROOT, 'public'), SKILL_ROOT = resolve(ROOT, 'skills');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'";
const staticFiles = new Map([['/', 'index.html'], ...['app.js', 'model.js', 'render.js', 'style.css', 'slide.css', 'presentation.js'].map(f => [`/${f}`, f])]);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const skillLabels = ['Discovery narrative', 'Technical architecture', 'Pilot readout', 'Deck review'];
const identifier = '[a-zA-Z0-9_-]{1,80}';
const entryPath = new RegExp(`^/api/decks/(${identifier})(?:/(duplicate|archive|checkpoints|brief\\.zip|brief)(?:/(${identifier})(?:/(restore))?)?)?$`);
const mutationPath = new RegExp(`^/api/decks/(${identifier})/(?:duplicate|archive|checkpoints(?:/${identifier}/restore)?)$`);
async function rendererRevision() {
  const hash = createHash('sha256');
  for (const name of ['render.js', 'model.js', 'slide.css']) hash.update(name).update('\0').update(await readFile(resolve(PUBLIC, name))).update('\0');
  return hash.digest('hex');
}
function receive(req, maxBytes) {
  return new Promise((accept, reject) => {
    let bytes = 0, failed = false; const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) { if (!failed) { failed = true; reject(problem(413, 'Request exceeds the deck limit of 1 MiB plus bounded brief fields.')); } return; }
      if (!failed) chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      try { accept(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new ValidationError('Request: invalid JSON.')); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(problem(400, 'Request interrupted.')));
  });
}
export async function createApp({ dataDir = resolve(ROOT, 'data'), dataFile = resolve(dataDir, 'deck.json') } = {}) {
  const canonicalRoot = await realpath(ROOT);
  let ancestor = dirname(resolve(dataFile)), canonicalAncestor;
  while (true) {
    try { canonicalAncestor = await realpath(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error; ancestor = dirname(ancestor); }
  }
  dataFile = resolve(canonicalAncestor, relative(ancestor, resolve(dataFile)));
  if (!dataFile.startsWith(canonicalRoot + '/')) throw new Error('Storage must stay within the Fielddeck directory.');
  if (['workspace.json', 'deck.pre-migration.json'].includes(basename(dataFile))) throw new Error('Legacy dataFile must not use a reserved workspace or backup filename.');
  const workspaceFile = resolve(dirname(dataFile), 'workspace.json'), backupFile = resolve(dirname(dataFile), 'deck.pre-migration.json');
  let { workspace, legacy } = await openWorkspace(dataFile, workspaceFile);
  let writeQueue = Promise.resolve();
  const requireWorkspace = () => { if (!workspace) throw problem(409, 'Explicit legacy migration is required before opening or modifying this workspace.'); };
  const entryFor = id => { requireWorkspace(); const entry = workspace.decks.find(item => item.deck.id === id); if (!entry) throw problem(404, 'Deck not found.'); return entry; };
  const workspaceSummary = async () => ({
    version: 2, primaryDeckId: workspace?.primaryDeckId ?? null,
    decks: workspace ? workspace.decks.map(entry => ({ id: entry.deck.id, title: entry.deck.title, archived: entry.archived, revision: entryRevision(entry), checkpointCount: entry.checkpoints.length })) : [],
    limits: WORKSPACE_LIMITS, rendererRevision: await rendererRevision(), migrationRequired: !workspace,
    ...(!workspace ? { legacyTitle: legacy.title, legacyRevision: revisionOf(legacy) } : {})
  });
  const commit = async candidate => { const next = validateWorkspace(candidate); await atomicWrite(workspaceFile, next); workspace = next; };
  const match = (expected, actual) => {
    if (!expected) throw problem(428, 'Reload the deck before saving (If-Match required).');
    if (expected !== actual) throw problem(409, 'Another window changed this deck. Export your edits, then reload to avoid overwriting them.');
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', CSP); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); res.setHeader('Cache-Control', 'no-store');
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': type });
      res.end(req.method === 'HEAD' ? undefined : Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
    };
    const sendDetail = (entry, status = 200, extra = {}) => { res.setHeader('ETag', entryRevision(entry)); send(status, { ...detail(entry), ...extra }); };
    try {
      const port = server.address()?.port, hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host)) return send(403, { error: 'Untrusted Host. Open the loopback URL printed by Fielddeck.' });
      const origin = req.headers.origin;
      if ((origin && !hosts.map(host => `http://${host}`).includes(origin)) || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Cross-origin requests are not allowed.' });
      if (!req.url.startsWith('/') || req.url.startsWith('//')) return send(400, { error: 'Invalid request path.' });
      const url = new URL(req.url, `http://${req.headers.host}`), path = url.pathname;
      const route = entryPath.exec(path);
      if (!['GET', 'HEAD', 'PUT', 'POST'].includes(req.method) || (req.method === 'POST' && path !== '/api/decks' && path !== '/api/workspace/migrate' && !mutationPath.test(path))) {
        res.setHeader('Allow', 'GET, HEAD, PUT, POST'); return send(405, { error: 'Method not allowed.' });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        if (req.method === 'PUT' && path !== '/api/deck' && !(route && !route[2])) return send(404, { error: 'Not found.' });
        if (!origin || origin !== `http://${req.headers.host}`) return send(403, { error: 'Saving requires a matching loopback Origin.' });
        if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) return send(415, { error: 'Use application/json.' });
        if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return send(415, { error: 'Compressed imports are not supported.' });
        const body = await receive(req, path === '/api/deck' ? MAX_BYTES : MAX_BYTES + 32768), expected = req.headers['if-match'];
        const job = writeQueue.then(async () => {
          if (path === '/api/workspace/migrate') {
            strictObject(body, ['confirm']);
            if (body.confirm !== true) throw new ValidationError('Migration requires confirm: true.');
            if (workspace) throw problem(409, 'This workspace has already been initialized.');
            match(expected, revisionOf(legacy));
            const disk = parseDeck((await regularFile(dataFile, MAX_BYTES)).toString('utf8'));
            if (revisionOf(disk) !== expected) { legacy = disk; throw problem(409, 'The legacy deck changed on disk. Reload before confirming migration.'); }
            const deck = await preserveLegacy(dataFile, backupFile);
            if (revisionOf(deck) !== expected) { legacy = deck; throw problem(409, 'The legacy deck changed during backup. No workspace was created.'); }
            await commit({ version: 2, primaryDeckId: deck.id, decks: [newEntry(deck)] });
            return send(200, await workspaceSummary());
          }
          requireWorkspace();
          if (path === '/api/decks') {
            strictObject(body, ['title', 'starter', 'brief']);
            boundedText(body.title, 140, 'Deck title');
            if (!['blank', 'sample', ...STARTERS].includes(body.starter)) throw new ValidationError('Starter must be blank, sample, or one of the three supported starter skill IDs.');
            if (workspace.decks.length >= WORKSPACE_LIMITS.decks) throw problem(409, `The library limit is ${WORKSPACE_LIMITS.decks} decks including archives. No decks were deleted.`);
            const brief = body.brief === null ? null : validateBrief(body.brief);
            let deck;
            if (body.starter === 'blank') deck = { version: 1, id: 'temporary', title: body.title, slides: [{ id: 'opening', layout: 'title', title: body.title }] };
            else if (body.starter === 'sample') deck = sampleDeck();
            else {
              const files = await skillFiles(SKILL_ROOT, body.starter);
              deck = parseDeck(files.find(file => file.name === `skills/${body.starter}/assets/template.json`).data.toString('utf8'));
            }
            deck = validateDeck({ ...deck, id: `d-${randomUUID()}`, title: body.title, audience: brief ? brief.audience : deck.audience });
            const entry = newEntry(deck, brief), next = structuredClone(workspace); next.decks.push(entry); await commit(next);
            return sendDetail(entryFor(deck.id), 201);
          }
          const id = path === '/api/deck' ? workspace.primaryDeckId : route[1], entry = entryFor(id);
          match(expected, entryRevision(entry));
          const next = structuredClone(workspace), target = next.decks.find(item => item.deck.id === id);
          const action = route?.[2]; let createdCheckpoint;
          if (req.method === 'PUT') {
            if (entry.archived) throw problem(409, 'This deck is archived. Unarchive it before editing.');
            let deck, brief;
            if (path === '/api/deck') { deck = validateDeck(body); brief = target.brief; }
            else { strictObject(body, ['deck', 'brief']); deck = validateDeck(body.deck); brief = body.brief === null ? null : validateBrief(body.brief); }
            if (deck.id !== id) throw new ValidationError('Deck ID must match the saved deck ID in the request path.');
            target.deck = deck; target.brief = brief;
          } else if (action === 'duplicate') {
            strictObject(body, ['title']); boundedText(body.title, 140, 'Deck title');
            if (next.decks.length >= WORKSPACE_LIMITS.decks) throw problem(409, `The library limit is ${WORKSPACE_LIMITS.decks} decks including archives. No decks were deleted.`);
            const copy = newEntry({ ...structuredClone(entry.deck), id: `d-${randomUUID()}`, title: body.title }, structuredClone(entry.brief));
            next.decks.push(copy); await commit(next); return sendDetail(entryFor(copy.deck.id), 201);
          } else if (action === 'archive') {
            strictObject(body, ['archived']);
            if (typeof body.archived !== 'boolean') throw new ValidationError('archived must be a boolean.');
            target.archived = body.archived;
          } else if (action === 'checkpoints') {
            if (entry.archived) throw problem(409, 'This deck is archived. Unarchive it before creating or restoring checkpoints.');
            if (route[4] === 'restore') {
              strictObject(body, ['confirm']); if (body.confirm !== true) throw new ValidationError('Restore requires confirm: true.');
              const checkpoint = target.checkpoints.find(item => item.id === route[3]); if (!checkpoint) throw problem(404, 'Checkpoint not found.');
              target.deck = structuredClone(checkpoint.deck); target.brief = structuredClone(checkpoint.brief);
            } else {
              strictObject(body, ['name']); boundedText(body.name, WORKSPACE_LIMITS.checkpointName, 'Checkpoint name');
              if (target.checkpoints.length >= WORKSPACE_LIMITS.checkpointsPerDeck) throw problem(409, `This deck has reached the limit of ${WORKSPACE_LIMITS.checkpointsPerDeck} checkpoints. Existing checkpoints were preserved.`);
              createdCheckpoint = { id: `cp-${randomUUID()}`, name: body.name, createdAt: new Date().toISOString(), deck: structuredClone(target.deck), brief: structuredClone(target.brief) };
              target.checkpoints.push(createdCheckpoint);
            }
          } else throw problem(404, 'Not found.');
          if (target.counter >= Number.MAX_SAFE_INTEGER) throw problem(409, 'This deck reached its revision limit. Duplicate it to continue editing.');
          target.counter++; await commit(next);
          return sendDetail(entryFor(id), 200, createdCheckpoint ? { checkpoint: metadata(createdCheckpoint) } : {});
        });
        writeQueue = job.catch(() => {}); await job; return;
      }
      if (path === '/api/workspace') return send(200, await workspaceSummary());
      if (path === '/api/skills') return send(200, { skills: SKILLS.map((id, index) => ({ id, label: skillLabels[index], starter: STARTERS.includes(id) })) });
      if (path === '/api/sample') return send(200, { deck: sampleDeck() });
      if (path === '/api/deck') { requireWorkspace(); return sendDetail(entryFor(workspace.primaryDeckId)); }
      if (route) {
        const entry = entryFor(route[1]);
        if (!route[2]) return sendDetail(entry);
        if (route[2] === 'checkpoints' && route[3] && !route[4]) {
          const checkpoint = entry.checkpoints.find(item => item.id === route[3]); if (!checkpoint) throw problem(404, 'Checkpoint not found.');
          return send(200, checkpoint);
        }
        if (['brief', 'brief.zip'].includes(route[2]) && !route[3]) {
          if (!entry.brief) throw problem(409, 'Save an agent brief before exporting a handoff.');
          if (route[2] === 'brief') { res.setHeader('Content-Disposition', `attachment; filename="${entry.deck.id}-agent-brief.json"`); return send(200, entry.brief); }
          if ([...url.searchParams.keys()].some(key => key !== 'skill') || url.searchParams.getAll('skill').length > 1) throw new ValidationError('Only a single allowlisted skill ID is accepted; paths are not supported.');
          const skill = url.searchParams.has('skill') ? url.searchParams.get('skill') : entry.brief.skill;
          const zip = await briefBundle(SKILL_ROOT, entry, skill);
          res.setHeader('Content-Disposition', `attachment; filename="${entry.deck.id}-agent-handoff.zip"`);
          return send(200, zip, 'application/zip');
        }
        throw problem(404, 'Not found.');
      }
      if (path === '/api/export/html' || path === '/present') {
        requireWorkspace();
        if ([...url.searchParams.keys()].some(key => key !== 'deckId') || url.searchParams.getAll('deckId').length > 1) throw new ValidationError('Only a single deckId is accepted.');
        const entry = entryFor(url.searchParams.has('deckId') ? url.searchParams.get('deckId') : workspace.primaryDeckId);
        const [css, presentationJS] = await Promise.all(['slide.css', 'presentation.js'].map(file => readFile(resolve(PUBLIC, file), 'utf8')));
        const html = exportHTML(entry.deck, css, presentationJS);
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'sha256-" + createHash('sha256').update(presentationJS).digest('base64') + "'; style-src 'sha256-" + createHash('sha256').update(css).digest('base64') + "'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
        if (path === '/api/export/html') res.setHeader('Content-Disposition', 'attachment; filename="fielddeck-presentation.html"');
        return send(200, html, 'text/html; charset=utf-8');
      }
      const file = staticFiles.get(path); if (!file) return send(404, { error: 'Not found.' });
      return send(200, await readFile(resolve(PUBLIC, file)), mime[extname(file)]);
    } catch (error) {
      const status = error.status || (error instanceof ValidationError ? 400 : 500);
      if (status === 500) console.error('Fielddeck request failed:', error.message);
      send(status, { error: status === 500 ? 'Could not complete the request. Your previous saved workspace is preserved; check the server terminal.' : error.message });
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  return server;
}
export const createServer = createApp;
export async function start(port = 4311, options = {}) {
  const server = await createApp(options);
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', accept); });
  console.log(`Fielddeck is ready at http://127.0.0.1:${server.address().port}\nWorkspace storage: ${resolve(dirname(options.dataFile || resolve(options.dataDir || resolve(ROOT, 'data'), 'deck.json')), 'workspace.json')}\nPress Ctrl+C to stop. No cloud services or runtime dependencies.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(() => process.exit(0)); server.closeIdleConnections(); });
  return server;
}
if (process.argv[1] && await realpath(resolve(process.argv[1])).catch(() => '') === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Fielddeck — local slide studio\n\nUsage: node server.js [--port PORT]\n       npm start -- --port 4311\n       npm test\n\nDefault: http://127.0.0.1:4311 (loopback only)\nStorage: data/workspace.json beside this server; writes are atomic.\nExisting deck.json requires explicit migration and is preserved byte-for-byte in deck.pre-migration.json.\nDeck JSON imports update the selected deck after confirmation. Export a backup first.\nHTML export is standalone and offline; notes stay private in JSON.\nPrint / PDF opens a presentation; use the browser print dialog.\nPortable agent skills are in skills/; nothing is installed globally.');
  } else if (args.length && !(args.length === 2 && args[0] === '--port' && /^\d+$/.test(args[1]) && +args[1] >= 1024 && +args[1] <= 65535)) {
    console.error('Invalid arguments. Use node server.js --help.'); process.exitCode = 1;
  } else {
    start(args.length ? +args[1] : 4311).catch(error => { console.error(`Fielddeck could not start: ${error.message}`); process.exitCode = 1; });
  }
}
