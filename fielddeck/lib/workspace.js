import { mkdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { validateDeck, parseDeck, validateBrief, ValidationError, MAX_BYTES } from '../public/model.js';
import { sampleDeck } from './sample.js';

export const WORKSPACE_LIMITS = Object.freeze({ decks: 24, checkpointsPerDeck: 12, workspaceBytes: 32 * 1024 * 1024, checkpointName: 120 });
export const revisionOf = deck => '"' + createHash('sha256').update(JSON.stringify(deck)).digest('hex') + '"';
export const entryRevision = entry => `"${entry.deck.id}:${entry.counter}:${createHash('sha256').update(JSON.stringify(entry)).digest('hex')}"`;
export const problem = (status, message) => Object.assign(new Error(message), { status });
export function strictObject(value, keys, required = keys, label = 'Request') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ValidationError(`${label}: expected a plain object.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ValidationError(`${label}: unknown field "${key}".`);
  for (const key of required) if (!Object.hasOwn(value, key)) throw new ValidationError(`${label}.${key}: required field.`);
}
export function boundedText(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidationError(`${label}: provide nonempty text of at most ${max} characters, without control characters.`);
  return value;
}
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
export const metadata = ({ id, name, createdAt }) => ({ id, name, createdAt });
export const detail = entry => ({ deck: structuredClone(entry.deck), brief: structuredClone(entry.brief), archived: entry.archived, revision: entryRevision(entry), checkpoints: entry.checkpoints.map(metadata) });
export const newEntry = (deck, brief = null) => ({ deck, brief, archived: false, checkpoints: [], counter: 1 });
export function validateWorkspace(input) {
  strictObject(input, ['version', 'primaryDeckId', 'decks'], undefined, 'Workspace');
  if (input.version !== 2 || !validId(input.primaryDeckId)) throw new ValidationError('Workspace: expected version 2 and a valid primaryDeckId.');
  if (!Array.isArray(input.decks) || input.decks.length < 1 || input.decks.length > WORKSPACE_LIMITS.decks) throw problem(409, `The library supports at most ${WORKSPACE_LIMITS.decks} decks, including archives. No decks have been removed.`);
  const ids = new Set();
  const decks = input.decks.map(entry => {
    strictObject(entry, ['deck', 'brief', 'archived', 'checkpoints', 'counter'], undefined, 'Workspace entry');
    const deck = validateDeck(entry.deck), brief = entry.brief === null ? null : validateBrief(entry.brief);
    if (ids.has(deck.id)) throw new ValidationError('Workspace: duplicate deck ID.');
    ids.add(deck.id);
    if (typeof entry.archived !== 'boolean' || !Number.isSafeInteger(entry.counter) || entry.counter < 1) throw new ValidationError('Workspace: invalid archive flag or monotonic revision counter.');
    if (!Array.isArray(entry.checkpoints) || entry.checkpoints.length > WORKSPACE_LIMITS.checkpointsPerDeck) throw problem(409, `Each deck supports at most ${WORKSPACE_LIMITS.checkpointsPerDeck} checkpoints. No checkpoints have been removed.`);
    const checkpointIds = new Set();
    const checkpoints = entry.checkpoints.map(checkpoint => {
      strictObject(checkpoint, ['id', 'name', 'createdAt', 'deck', 'brief'], undefined, 'Checkpoint');
      if (!validId(checkpoint.id) || checkpointIds.has(checkpoint.id)) throw new ValidationError('Checkpoint: invalid or duplicate ID.');
      checkpointIds.add(checkpoint.id);
      boundedText(checkpoint.name, WORKSPACE_LIMITS.checkpointName, 'Checkpoint name');
      if (typeof checkpoint.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(checkpoint.createdAt) || !Number.isFinite(Date.parse(checkpoint.createdAt))) throw new ValidationError('Checkpoint: invalid creation timestamp.');
      const snapshot = validateDeck(checkpoint.deck);
      if (snapshot.id !== deck.id) throw new ValidationError('Checkpoint: snapshot deck ID must match its entry.');
      return { ...metadata(checkpoint), deck: snapshot, brief: checkpoint.brief === null ? null : validateBrief(checkpoint.brief) };
    });
    return { deck, brief, archived: entry.archived, checkpoints, counter: entry.counter };
  });
  if (!ids.has(input.primaryDeckId)) throw new ValidationError('Workspace: primary deck is missing.');
  const workspace = { version: 2, primaryDeckId: input.primaryDeckId, decks };
  if (Buffer.byteLength(JSON.stringify(workspace, null, 2) + '\n') > WORKSPACE_LIMITS.workspaceBytes) throw problem(413, 'The workspace limit is 32 MiB including checkpoints. Export a backup and reduce deck content before retrying. Nothing was deleted.');
  return workspace;
}
export async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temp, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
}
export async function regularFile(path, maxBytes) {
  const info = await lstat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error(`Saved file must be regular and at most ${maxBytes} bytes.`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) throw new Error('Saved file is not a bounded regular file.');
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error('Saved file exceeds its size limit.');
    return bytes;
  } finally { await handle.close(); }
}
export async function openWorkspace(dataFile, workspaceFile) {
  let legacy = null, workspace = null;
  // Validate both existing sources. Corruption is never interpreted as an empty workspace.
  try { legacy = parseDeck((await regularFile(dataFile, MAX_BYTES)).toString('utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot load saved deck; original file has been preserved. ${error.message}`); }
  try { workspace = validateWorkspace(JSON.parse((await regularFile(workspaceFile, WORKSPACE_LIMITS.workspaceBytes)).toString('utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot load workspace; original file has been preserved. ${error.message}`); }
  if (!workspace && !legacy) {
    const deck = sampleDeck();
    workspace = validateWorkspace({ version: 2, primaryDeckId: deck.id, decks: [newEntry(deck)] });
    await atomicWrite(workspaceFile, workspace);
  }
  return { workspace, legacy };
}
export async function preserveLegacy(dataFile, backupFile) {
  const bytes = await regularFile(dataFile, MAX_BYTES);
  const deck = parseDeck(bytes.toString('utf8'));
  let handle;
  try { handle = await open(backupFile, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // A crash after the backup but before workspace commit is recoverable, without overwriting it.
    const existing = await regularFile(backupFile, MAX_BYTES).catch(() => null);
    if (!existing || !existing.equals(bytes)) throw problem(409, 'deck.pre-migration.json already exists and does not match the original. Preserve both files and resolve the backup conflict before migrating.');
    return deck;
  }
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(dirname(backupFile), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return deck;
}
