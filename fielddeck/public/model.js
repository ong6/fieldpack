export const LAYOUTS = ['title', 'findings', 'architecture', 'comparison', 'results', 'next-steps'];
export const THEMES = ['navy', 'cream', 'coral'];
export const LABELS = ['evidence', 'assumption', 'proposal'];
export const MAX_SLIDES = 30;
export const MAX_BYTES = 1024 * 1024;
export const LIMITS = { title: 140, subtitle: 360, notes: 8000, source: 400, text: 400 };

export class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}
const fail = (path, message) => { throw new ValidationError(`${path}: ${message}`); };
function object(value, path, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(path, `unknown field "${key}"`);
}
function str(value, path, max, fallback = '') {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') fail(path, 'expected text');
  if (value.length > max) fail(path, `must be ${max} characters or fewer`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(path, 'contains unsupported control characters');
  return value;
}
function choice(value, path, options, fallback) {
  if (value === undefined && fallback) return fallback;
  if (!options.includes(value)) fail(path, `expected ${options.join(', ')}`);
  return value;
}
function id(value, path) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) fail(path, 'expected 1–80 letters, digits, hyphens or underscores');
  return value;
}
function list(value, path, max, fields) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail(path, `expected an array with at most ${max} items`);
  return value.map((row, i) => {
    const at = `${path}[${i + 1}]`;
    object(row, at, Object.keys(fields));
    return Object.fromEntries(Object.entries(fields).map(([key, limit]) => [key,
      key === 'labelType' ? choice(row[key], `${at}.${key}`, LABELS, 'assumption') : str(row[key], `${at}.${key}`, limit)]));
  });
}
export function validateDeck(input) {
  object(input, 'Deck', ['version', 'id', 'title', 'subtitle', 'audience', 'theme', 'slides']);
  if (input.version !== 1) fail('Deck.version', 'only version 1 is supported');
  const deck = {
    version: 1, id: id(input.id, 'Deck.id'), title: str(input.title, 'Deck.title', 140),
    subtitle: str(input.subtitle, 'Deck.subtitle', 360), audience: str(input.audience, 'Deck.audience', 160),
    theme: choice(input.theme, 'Deck.theme', THEMES, 'navy'), slides: []
  };
  if (!deck.title.trim()) fail('Deck.title', 'a title is required');
  if (!Array.isArray(input.slides) || input.slides.length < 1 || input.slides.length > MAX_SLIDES) fail('Deck.slides', `expected 1–${MAX_SLIDES} slides`);
  const ids = new Set();
  deck.slides = input.slides.map((s, i) => {
    const p = `Slide ${i + 1}`;
    object(s, p, ['id', 'layout', 'eyebrow', 'title', 'subtitle', 'label', 'source', 'points', 'nodes', 'columns', 'metrics', 'actions', 'notes']);
    const slideId = id(s.id, `${p}.id`);
    if (ids.has(slideId)) fail(`${p}.id`, 'duplicate slide id');
    ids.add(slideId);
    return {
      id: slideId, layout: choice(s.layout, `${p}.layout`, LAYOUTS),
      eyebrow: str(s.eyebrow, `${p}.eyebrow`, 80), title: str(s.title, `${p}.title`, 140),
      subtitle: str(s.subtitle, `${p}.subtitle`, 360), label: choice(s.label, `${p}.label`, LABELS, 'assumption'),
      source: str(s.source, `${p}.source`, 400),
      points: list(s.points, `${p}.points`, 6, { text: 400, labelType: 0, source: 400 }),
      nodes: list(s.nodes, `${p}.nodes`, 5, { name: 80, detail: 240 }),
      columns: list(s.columns, `${p}.columns`, 3, { heading: 80, body: 700 }),
      metrics: list(s.metrics, `${p}.metrics`, 4, { value: 40, label: 120, source: 400 }),
      actions: list(s.actions, `${p}.actions`, 6, { text: 240, owner: 80, date: 80 }),
      notes: str(s.notes, `${p}.notes`, 8000)
    };
  });
  if (new TextEncoder().encode(JSON.stringify(deck, null, 2) + '\n').length > MAX_BYTES) fail('Deck', 'normalized deck must be 1 MiB or smaller');
  return deck;
}
export function parseDeck(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > MAX_BYTES) fail('Import', 'file must be 1 MiB or smaller');
  let input;
  try { input = JSON.parse(text); } catch { fail('Import', 'invalid JSON'); }
  return validateDeck(input);
}
export function makeSlide(layout = 'findings') {
  return {
    id: `s-${globalThis.crypto.randomUUID()}`, layout, eyebrow: 'FIELD NOTES', title: 'Make one clear point',
    subtitle: '', label: 'assumption', source: '', notes: '',
    points: layout === 'findings' ? [{ text: 'Add a finding and identify its evidence.', labelType: 'assumption', source: '' }] : [],
    nodes: layout === 'architecture' ? [{ name: 'Input', detail: 'Define the source and trust boundary' }, { name: 'Service', detail: 'Define processing and failure behavior' }, { name: 'Output', detail: 'Define the consumer and contract' }] : [],
    columns: layout === 'comparison' ? [{ heading: 'Current approach', body: 'Describe the current trade-offs.' }, { heading: 'Proposed approach', body: 'Describe the proposed trade-offs.' }] : [],
    metrics: layout === 'results' ? [{ value: 'TBD', label: 'Metric · define baseline and sample', source: '' }] : [],
    actions: layout === 'next-steps' ? [{ text: 'Agree on the next decision', owner: 'Assign an owner', date: 'Set a date' }] : []
  };
}
export function visibleText(slide) {
  const common = [slide.eyebrow, slide.title, slide.subtitle, slide.source];
  const fields = { title: [], findings: slide.points.flatMap(p => [p.text, p.source]), architecture: slide.nodes.flatMap(n => [n.name, n.detail]), comparison: slide.columns.flatMap(c => [c.heading, c.body]), results: slide.metrics.flatMap(m => [m.value, m.label, m.source]), 'next-steps': slide.actions.flatMap(a => [a.text, a.owner, a.date]) };
  return [...common, ...(fields[slide.layout] || [])].filter(Boolean).join(' ');
}
export function reviewDeck(deck) {
  const issues = [];
  const add = (slide, code, message, severity = 'warning') => issues.push({ slideId: slide?.id || null, code, message, severity });
  if (!deck.slides.some(s => s.layout === 'next-steps' && s.actions.some(a => a.text.trim()))) add(null, 'next-steps', 'Add a next-steps slide with an explicit decision or action.');
  deck.slides.forEach((s, i) => {
    const n = `Slide ${i + 1}`;
    if (!s.title.trim()) add(s, 'title', `${n}: give this slide a takeaway headline.`);
    if (s.label === 'evidence' && !s.source.trim()) add(s, 'source', `${n}: evidence needs a slide-level source.`);
    if (s.layout === 'findings') s.points.forEach((p, j) => { if (p.labelType === 'evidence' && !p.source.trim() && !s.source.trim()) add(s, 'source', `${n}, finding ${j + 1}: add a source or label it as an assumption.`); });
    if (s.layout === 'results') s.metrics.forEach((m, j) => { if (!m.source.trim() && !s.source.trim()) add(s, 'source', `${n}, metric ${j + 1}: add provenance, sample, and measurement window.`); });
    const words = visibleText(s).split(/\s+/).filter(Boolean).length;
    if (words > (s.layout === 'title' ? 65 : 135) || s.title.length > 95) add(s, 'density', `${n}: ${words} visible words; consider tightening or splitting. This is a density heuristic, not a measured overflow test.`);
    const key = { findings: 'points', architecture: 'nodes', comparison: 'columns', results: 'metrics', 'next-steps': 'actions' }[s.layout];
    if (key && !s[key].length) add(s, 'empty', `${n}: add content for the ${s.layout} layout.`);
    if (s.layout === 'next-steps' && s.actions.some(a => !a.owner.trim() || !a.date.trim())) add(s, 'ownership', `${n}: every action needs an owner and target date.`);
  });
  return issues;
}

// Shared by the browser and the local workspace API; these are identifiers, not paths.
export const SKILLS = Object.freeze(['fde-discovery-narrative', 'fde-technical-architecture', 'fde-pilot-readout', 'fde-deck-review']);
export const STARTERS = Object.freeze(SKILLS.slice(0, 3));
export const BRIEF_LIMITS = Object.freeze({ audience: 160, decision: 1000, constraints: 2000, evidenceGaps: 2000 });
export function validateBrief(input) {
  const allowed = ['version', 'skill', ...Object.keys(BRIEF_LIMITS)];
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('Brief', 'expected a plain object');
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !allowed.includes(key)) fail('Brief', `unknown field "${String(key)}"`);
    if (!Object.getOwnPropertyDescriptor(input, key).enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value')) fail('Brief', 'only ordinary fields are supported');
  }
  for (const key of allowed) if (!Object.hasOwn(input, key)) fail(`Brief.${key}`, 'required field');
  if (input.version !== 1) fail('Brief.version', 'only version 1 is supported');
  const brief = { version: 1, skill: choice(input.skill, 'Brief.skill', SKILLS) };
  for (const [key, limit] of Object.entries(BRIEF_LIMITS)) {
    if (typeof input[key] !== 'string') fail(`Brief.${key}`, 'expected text');
    brief[key] = str(input[key], `Brief.${key}`, limit);
  }
  return brief;
}
