import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateDeck, validateBrief, parseDeck, STARTERS, reviewDeck, makeSlide } from './public/model.js';
import { exportHTML } from './public/render.js';
import { sampleDeck } from './lib/sample.js';
import { skillFiles, briefBundle } from './lib/zip.js';
import { atomicWrite, openWorkspace, preserveLegacy, validateWorkspace, newEntry, detail, entryRevision, WORKSPACE_LIMITS } from './lib/workspace.js';
import { fault, fingerprint } from './agent/workspace.mjs';
export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export class FielddeckService {
  constructor(root) { this.root = root; this.file = path.join(root, 'workspace.json'); this.legacyFile = path.join(root, 'deck.json'); }
  async open() { const loaded = await openWorkspace(this.legacyFile, this.file); Object.assign(this, loaded); return this; }
  ready() { if (!this.workspace) throw fault('MIGRATION_REQUIRED', 'Legacy deck requires explicit workspace.migrate confirmation.', 409); }
  entry(id) { this.ready(); const entry = this.workspace.decks.find(e => e.deck.id === id); if (!entry) throw fault('NOT_FOUND', 'Deck not found.', 404); return entry; }
  get(id) { return detail(this.entry(id)); }
  list() { this.ready(); return this.workspace.decks.map(e => ({ id: e.deck.id, title: e.deck.title, archived: e.archived, revision: entryRevision(e), checkpointCount: e.checkpoints.length })); }
  async save(next) { const valid = validateWorkspace(next); await atomicWrite(this.file, valid); this.workspace = valid; }
  expect(entry, revision) { if (entryRevision(entry) !== revision) throw fault('CONFLICT', 'Deck changed. Read its current revision before updating.', 409); }
  async migrate(confirm, revision) { if (this.workspace) throw fault('CONFLICT', 'Workspace already initialized.', 409); if (!confirm) throw fault('CONFIRMATION_REQUIRED', 'Migration requires confirm: true.'); const { revisionOf } = await import('./lib/workspace.js'); if (revision !== revisionOf(this.legacy)) throw fault('CONFLICT', 'Legacy deck changed.', 409); const deck = await preserveLegacy(this.legacyFile, path.join(this.root, 'deck.pre-migration.json')); if (revisionOf(deck) !== revision) throw fault('CONFLICT', 'Legacy deck changed during backup.', 409); await this.save({ version: 2, primaryDeckId: deck.id, decks: [newEntry(deck)] }); return this.get(deck.id); }
  async create({ title, starter = 'blank', brief = null, deck: supplied, requestId, dryRun = false }) {
    this.ready(); const id = requestId ? `d-${requestId}` : `d-${randomUUID()}`;
    if (this.workspace.decks.some(e => e.deck.id === id)) throw fault('ALREADY_EXISTS', `Request ID already created deck ${id}; retrieve it instead of duplicating.`, 409);
    let deck = supplied;
    if (!deck && starter === 'sample') deck = sampleDeck();
    if (!deck && STARTERS.includes(starter)) { const files = await skillFiles(path.join(ROOT, 'skills'), starter); deck = parseDeck(files.find(f => f.name.endsWith('/assets/template.json')).data.toString()); }
    if (!deck) deck = { version: 1, id, title, slides: [{ id: 'opening', layout: 'title', title }] };
    const entry = newEntry(validateDeck({ ...deck, id, title, audience: brief ? brief.audience : deck.audience }), brief === null ? null : validateBrief(brief));
    const next = structuredClone(this.workspace); next.decks.push(entry); validateWorkspace(next); if (!dryRun) await this.save(next); return { ...detail(entry), dryRun };
  }
  async change(id, revision, action, { dryRun = false, allowArchived = false } = {}) {
    const current = this.entry(id); this.expect(current, revision); if (current.archived && !allowArchived) throw fault('ARCHIVED', 'Unarchive the deck before editing.', 409);
    const next = structuredClone(this.workspace), target = next.decks.find(e => e.deck.id === id); await action(target);
    target.counter++; validateWorkspace(next); if (!dryRun) await this.save(next); return { ...detail(target), dryRun };
  }
  update(input) { return this.change(input.id, input.revision, e => { const deck = validateDeck(input.deck); if (deck.id !== input.id) throw fault('ID_MISMATCH', 'Deck IDs must match.'); e.deck = deck; if (input.brief !== undefined) e.brief = input.brief === null ? null : validateBrief(input.brief); }, input); }
  archive(input) { return this.change(input.id, input.revision, e => { e.archived = input.archived; }, { ...input, allowArchived: true }); }
  duplicate(input) { const e = this.entry(input.id); this.expect(e, input.revision); return this.create({ ...input, deck: e.deck, brief: e.brief }); }
  checkpoint(input) { return this.change(input.id, input.revision, e => { e.checkpoints.push({ id: `cp-${randomUUID()}`, name: input.name, createdAt: new Date().toISOString(), deck: structuredClone(e.deck), brief: structuredClone(e.brief) }); }, input); }
  restore(input) { if (!input.confirm) throw fault('CONFIRMATION_REQUIRED', 'Restore requires confirm: true.'); return this.change(input.id, input.revision, e => { const cp = e.checkpoints.find(c => c.id === input.checkpointId); if (!cp) throw fault('NOT_FOUND', 'Checkpoint not found.', 404); e.deck = structuredClone(cp.deck); e.brief = structuredClone(cp.brief); }, input); }
  slide(input) { return this.change(input.id, input.revision, e => { const at = e.deck.slides.findIndex(s => s.id === input.slideId); if (input.action !== 'add' && at < 0) throw fault('NOT_FOUND', 'Slide not found.', 404); if (input.action === 'add') e.deck.slides.splice(input.position ?? e.deck.slides.length, 0, input.slide || makeSlide()); if (input.action === 'update') e.deck.slides[at] = { ...e.deck.slides[at], ...input.slide, id: input.slideId }; if (input.action === 'remove') e.deck.slides.splice(at, 1); if (input.action === 'move') { const [slide] = e.deck.slides.splice(at, 1); e.deck.slides.splice(input.position, 0, slide); } e.deck = validateDeck(e.deck); }, input); }
  async export(id, format, includePrivate = false) {
    const entry = this.entry(id);
    if (format === 'json' || format === 'brief.zip') { if (!includePrivate) throw fault('PRIVATE_CONFIRMATION_REQUIRED', 'JSON and brief ZIP include speaker notes. Set includePrivate: true.'); }
    let buffer, mediaType;
    if (format === 'json') { buffer = Buffer.from(JSON.stringify(entry.deck, null, 2)); mediaType = 'application/json'; }
    else if (format === 'brief.zip') { if (!entry.brief) throw fault('NO_BRIEF', 'Save a brief first.'); buffer = await briefBundle(path.join(ROOT, 'skills'), entry, entry.brief.skill); mediaType = 'application/zip'; }
    else { const [css, js] = await Promise.all(['slide.css', 'presentation.js'].map(f => readFile(path.join(ROOT, 'public', f), 'utf8'))); buffer = Buffer.from(exportHTML(entry.deck, css, js)); mediaType = 'text/html'; }
    return { artifact: { filename: `${id}.${format}`, mediaType, bytes: buffer.length, sha256: fingerprint(buffer), base64: buffer.toString('base64') }, revision: entryRevision(entry) };
  }
  review(id) { const entry = this.entry(id); return { deckId: id, revision: entryRevision(entry), contentHash: fingerprint(entry.deck), issues: reviewDeck(entry.deck), scope: 'Editorial checks only; not measured fit or factual verification.' }; }
}
