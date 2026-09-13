import { LAYOUTS, THEMES, LABELS, MAX_SLIDES, MAX_BYTES, LIMITS, makeSlide, validateDeck, parseDeck, reviewDeck, validateBrief } from './model.js';
import { renderSlide, measureSlideOverflow, escapeHTML as e } from './render.js';
const $ = selector => document.querySelector(selector);
const layoutNames = { title: 'Opening', findings: 'Findings', architecture: 'Architecture', comparison: 'Comparison', results: 'Results', 'next-steps': 'Next steps' };
const layoutDescriptions = { title: 'Set the stakes with one memorable idea.', findings: 'Connect observations to their evidence.', architecture: 'Explain the flow and its boundaries.', comparison: 'Make the trade-offs visible.', results: 'Show outcomes, baselines, and caveats.', 'next-steps': 'Name the decision, owner, and date.' };
let deck, revision, selected = 0, generation = 0, savedGeneration = 0, saveTimer, savePromise, toastTimer, presenting = 0;
let brief = null, deckId, archived = false, library, checkpoints = [], busy = false, rendererRevision = '', report = null, reviewToken = 0, checkpointPreview;
const undoStack = [], redoStack = [];
let historyBaseline, historyKey = '', historyAt = 0;
const HISTORY_LIMIT = 80, HISTORY_BYTES = 8 * 1024 * 1024;
const cloneState = () => structuredClone({ deck, brief, selected });
function trimHistory(stack) { while (undoStack.length + redoStack.length > HISTORY_LIMIT || new TextEncoder().encode(JSON.stringify([undoStack, redoStack])).length > HISTORY_BYTES) { const target = stack.length > 1 ? stack : (stack === undoStack ? redoStack : undoStack); if (!target.length) break; target.shift(); } }
function historyButtons() { $('#undo-button').disabled = archived || busy || !undoStack.length; $('#redo-button').disabled = archived || busy || !redoStack.length; }
function resetHistory() { undoStack.length = 0; redoStack.length = 0; historyBaseline = cloneState(); historyKey = ''; historyButtons(); }
function recordChange(key = '') {
  if (historyBaseline) {
    const now = Date.now();
    if (!key || key !== historyKey || now - historyAt > 1000) { undoStack.push(historyBaseline); trimHistory(undoStack); }
    historyAt = now; historyKey = key; redoStack.length = 0;
  }
  historyBaseline = cloneState(); historyButtons();
}
function travelHistory(forward = false) {
  if (archived || busy || !deck) return;
  const from = forward ? redoStack : undoStack, to = forward ? undoStack : redoStack;
  if (!from.length) return;
  to.push(cloneState()); trimHistory(to); const next = from.pop();
  deck = validateDeck(next.deck); brief = next.brief; selected = Math.min(next.selected, deck.slides.length - 1);
  historyBaseline = cloneState(); historyKey = ''; markDirty(); renderAll(); renderLibrary(); historyButtons(); notify(forward ? 'Change redone.' : 'Change undone.');
}
function invalidateReport(reason = 'Deck changed') {
  reviewToken++;
  if (report) report.stale = true;
  $('#preflight-status').textContent = report ? `Stale · ${reason}. Review again.` : 'Not reviewed';
  $('#preflight-status').dataset.state = 'stale'; $('#export-review-button').disabled = true;
}
function controls() {
  for (const selector of ['#editor-fields input', '#editor-fields textarea', '#editor-fields select', '#editor-fields button']) for (const node of document.querySelectorAll(selector)) node.disabled = archived || busy;
  for (const id of ['speaker-notes', 'deck-settings-button', 'import-button', 'save-button', 'save-brief-button', 'create-checkpoint-button', 'restore-checkpoint-button']) $(`#${id}`).disabled = archived || busy || !deck;
  for (const id of ['add-slide-button', 'add-slide-bottom', 'duplicate-button']) $(`#${id}`).disabled = archived || busy || !deck || deck.slides.length >= MAX_SLIDES;
  $('#move-up-button').disabled = archived || busy || !deck || selected === 0;
  $('#move-down-button').disabled = archived || busy || !deck || selected === deck.slides.length - 1;
  $('#delete-button').disabled = archived || busy || !deck || deck.slides.length === 1;
  $('#deck-switcher').disabled = busy || !deck;
  const config = deck && groupConfig[active().layout];
  if ($('#add-row-button')) $('#add-row-button').disabled = archived || busy || !config || active()[config.key].length >= config.max;
  $('#create-checkpoint-button').disabled = archived || busy || !deck || checkpoints.length >= 12;
  $('#archive-state').hidden = !archived; historyButtons();
}
async function guarded(work) {
  if (busy) return;
  busy = true; document.body.dataset.busy = 'true'; controls();
  try { return await work(); } catch (issue) { error(`${issue.message} Your current edits are preserved. Export JSON before reloading if there is a conflict.`); }
  finally { busy = false; document.body.dataset.busy = 'false'; controls(); }
}
const active = () => deck.slides[selected];
function notify(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200); }
function error(message) { $('#error-banner').textContent = message; $('#error-banner').hidden = false; }
function status(text, state = '') { $('#save-state').textContent = text; $('#save-state').dataset.state = state; }
function clearError() { $('#error-banner').hidden = true; $('#error-banner').textContent = ''; }
function markDirty() { generation++; invalidateReport(); status('Unsaved changes', 'dirty'); clearTimeout(saveTimer); saveTimer = setTimeout(() => { saveNow().catch(() => {}); }, 650); }
async function request(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || `Request failed (${response.status}).`); }
  return response;
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!deck) throw new Error('The workspace has not loaded.');
  if (savePromise) { await savePromise; if (generation > savedGeneration) return saveNow(); return; }
  if (generation === savedGeneration) return;
  let snapshot;
  try { snapshot = validateDeck(deck); } catch (issue) { status('Needs attention', 'error'); error(issue.message); throw issue; }
  const savingGeneration = generation, savingId = deckId, savingBrief = brief === null ? null : validateBrief(brief), expectedRevision = revision;
  status('Saving locally…');
  savePromise = (async () => {
    try {
      const response = await request(`/api/decks/${encodeURIComponent(savingId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': expectedRevision }, body: JSON.stringify({ deck: snapshot, brief: savingBrief }) });
      const data = await response.json();
      if (deckId !== savingId) throw new Error('Deck changed while saving; reload the saved entry before continuing.');
      revision = data.revision; savedGeneration = savingGeneration;
      const entry = library?.decks.find(item => item.id === deckId); if (entry) { entry.title = snapshot.title; entry.revision = revision; }
      renderLibrary();
      status(generation === savedGeneration ? 'Saved locally' : 'Unsaved changes', generation === savedGeneration ? '' : 'dirty');
      clearError();
    } catch (issue) { status('Not saved', 'error'); error(`${issue.message} Your edits are still in this window. Export JSON to keep a backup.`); throw issue; }
    finally { savePromise = null; }
  })();
  await savePromise;
  if (generation > savedGeneration) return saveNow();
}
function renderRail() {
  $('#slide-list').innerHTML = deck.slides.map((s, i) => `<li><button class="slide-select" data-slide="${i}" aria-current="${i === selected}" aria-label="Slide ${i + 1}: ${e(s.title || 'Untitled')}"><span class="thumb" aria-hidden="true">${renderSlide(s, i, deck.slides.length, deck.theme)}</span><span class="slide-caption"><b>${String(i + 1).padStart(2, '0')}</b><span>${e(s.title.replace(/\n/g, ' ') || 'Untitled slide')}</span></span></button></li>`).join('');
  $('#slide-count').textContent = deck.slides.length;
}
function renderQA() {
  const issues = reviewDeck(deck);
  const canvas = $('#preview .slide');
  const measurement = canvas ? measureSlideOverflow(canvas) : null;
  if (measurement?.issues.length) issues.unshift({ slideId: active().id, code: 'overflow', message: `Slide ${selected + 1}: measured preview overflow at ${measurement.width} × ${measurement.height}px. Content crosses the footer or canvas boundary. Split this slide or shorten visible copy before export; no content has been removed.` });
  $('#qa-count').textContent = issues.length;
  $('#qa-list').innerHTML = issues.length ? issues.map(issue => `<div class="qa-item"><span class="qa-mark" aria-hidden="true">!</span>${issue.slideId ? `<button data-qa-slide="${e(issue.slideId)}">${e(issue.message)}</button>` : `<span>${e(issue.message)}</span>`}</div>`).join('') : '<p class="qa-empty">Sources, structure, and next steps look ready for a human review. Inspect every slide before sharing.</p>';
}
function renderCanvas() {
  const s = active();
  $('#preview').innerHTML = renderSlide(s, selected, deck.slides.length, deck.theme);
  $('#canvas-layout').textContent = layoutNames[s.layout];
  $('#slide-position').textContent = `SLIDE ${String(selected + 1).padStart(2, '0')} / ${String(deck.slides.length).padStart(2, '0')} · 16:9`;
  $('#deck-title-display').textContent = deck.title;
  $('#deck-summary').textContent = `${deck.slides.length} slides`;
  $('#move-up-button').disabled = selected === 0;
  $('#move-down-button').disabled = selected === deck.slides.length - 1;
  $('#delete-button').disabled = deck.slides.length === 1;
  for (const id of ['add-slide-button', 'add-slide-bottom', 'duplicate-button']) $(`#${id}`).disabled = deck.slides.length >= MAX_SLIDES;
  renderQA(); controls();
}
const options = (values, chosen, names) => values.map(v => `<option value="${e(v)}" ${v === chosen ? 'selected' : ''}>${e(names?.[v] || v[0].toUpperCase() + v.slice(1))}</option>`).join('');
function textField(key, label, value, max, rows = 0, help = '') {
  const attrs = `id="edit-${key}" data-field="${key}" maxlength="${max}"`;
  return `<div class="editor-field"><label for="edit-${key}">${label}<span class="char-count" data-count="${key}">${value.length}/${max}</span></label>${rows ? `<textarea ${attrs} rows="${rows}">${e(value)}</textarea>` : `<input ${attrs} value="${e(value)}">`}${help ? `<p class="field-help">${help}</p>` : ''}</div>`;
}
const groupConfig = {
  findings: { key: 'points', name: 'Finding', max: 6, fields: [['text', 'Observation', 400, 3], ['labelType', 'Claim type', 0], ['source', 'Source / provenance', 400]], empty: { text: '', labelType: 'assumption', source: '' } },
  architecture: { key: 'nodes', name: 'Stage', max: 5, fields: [['name', 'Stage name', 80], ['detail', 'Details / boundary', 240, 3]], empty: { name: '', detail: '' } },
  comparison: { key: 'columns', name: 'Option', max: 3, fields: [['heading', 'Heading', 80], ['body', 'Trade-offs (new lines supported)', 700, 5]], empty: { heading: '', body: '' } },
  results: { key: 'metrics', name: 'Metric', max: 4, fields: [['value', 'Value / target', 40], ['label', 'Metric + baseline / window', 120, 2], ['source', 'Source / sample / method', 400, 2]], empty: { value: '', label: '', source: '' } },
  'next-steps': { key: 'actions', name: 'Action', max: 6, fields: [['text', 'Action / decision', 240, 2], ['owner', 'Owner', 80], ['date', 'Target date', 80]], empty: { text: '', owner: '', date: '' } }
};
function renderRows(s) {
  const config = groupConfig[s.layout]; if (!config) return '';
  return `<section class="field-section"><h3>${layoutNames[s.layout]} content <span class="count">${s[config.key].length}/${config.max}</span></h3>${s[config.key].map((row, i) => `<div class="row-editor"><div class="row-heading"><span>${config.name} ${i + 1}</span><button data-remove-row="${i}" aria-label="Remove ${config.name.toLowerCase()} ${i + 1}" title="Remove item">×</button></div>${config.fields.map(([key, label, max, rows]) => {
    const attrs = `id="row-${i}-${key}" data-group="${config.key}" data-index="${i}" data-key="${key}"`;
    return `<label for="row-${i}-${key}">${label}</label>${key === 'labelType' ? `<select ${attrs}>${options(LABELS, row[key])}</select>` : rows ? `<textarea ${attrs} maxlength="${max}" rows="${rows}">${e(row[key])}</textarea>` : `<input ${attrs} maxlength="${max}" value="${e(row[key])}">`}`;
  }).join('')}</div>`).join('')}<button class="add-row" id="add-row-button" ${s[config.key].length >= config.max ? 'disabled' : ''}>+ Add ${config.name.toLowerCase()}</button></section>`;
}
function renderEditor() {
  const s = active();
  $('#editor-fields').innerHTML = `<div class="editor-field"><label for="edit-layout">Layout</label><select id="edit-layout" data-field="layout">${options(LAYOUTS, s.layout, layoutNames)}</select></div><div class="editor-field"><label for="edit-label">Slide claim type</label><select id="edit-label" data-field="label">${options(LABELS, s.label)}</select></div>` +
    textField('eyebrow', 'Chapter label', s.eyebrow, 80) + textField('title', 'Takeaway headline', s.title, LIMITS.title, 3) + textField('subtitle', 'Supporting thought', s.subtitle, LIMITS.subtitle, 3) + textField('source', 'Slide source', s.source, LIMITS.source, 2, 'Citation, date, method, or an explicit fictional / proposed label.') + renderRows(s);
  $('#speaker-notes').value = s.notes;
}
function renderAll() { renderRail(); renderCanvas(); renderEditor(); controls(); }
function selectSlide(index, focus = false) { if (!deck || busy || index < 0 || index >= deck.slides.length) return; selected = index; if (historyBaseline) historyBaseline.selected = selected; historyKey = ''; renderAll(); if (focus && !archived) $('#edit-title').focus(); }
function changed({ editor = false, key = '' } = {}) { recordChange(key); markDirty(); renderRail(); renderCanvas(); if (editor) renderEditor(); controls(); }
function confirmChange(title, message, accept = 'Continue') {
  return new Promise(resolve => {
    const dialog = $('#confirm-dialog'); $('#confirm-title').textContent = title; $('#confirm-message').textContent = message; $('#confirm-accept').textContent = accept;
    const finish = result => { dialog.close(); $('#confirm-accept').onclick = null; $('#confirm-cancel').onclick = null; dialog.removeEventListener('cancel', cancel); resolve(result); };
    const cancel = event => { event.preventDefault(); finish(false); };
    $('#confirm-accept').onclick = () => finish(true); $('#confirm-cancel').onclick = () => finish(false); dialog.addEventListener('cancel', cancel);
    dialog.showModal(); $('#confirm-cancel').focus();
  });
}
function download(contents, type, extension) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement('a'); a.href = url; a.download = `${deck.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 70) || 'fielddeck'}.${extension}`;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function openLayoutChooser() { if (deck.slides.length >= MAX_SLIDES) return; $('#layout-dialog').showModal(); }
function addSlide(layout) { const s = makeSlide(layout); deck.slides.splice(selected + 1, 0, s); selected++; changed({ editor: true }); $('#layout-dialog').close(); $('#edit-title').focus(); notify(`${layoutNames[layout]} slide added.`); }
function replaceDeck(next) { deck = validateDeck({ ...next, id: deckId }); selected = 0; changed({ editor: true }); }
$('#slide-list').addEventListener('click', event => { const button = event.target.closest('[data-slide]'); if (button) selectSlide(+button.dataset.slide); });
$('#qa-list').addEventListener('click', event => { const button = event.target.closest('[data-qa-slide]'); if (button) selectSlide(deck.slides.findIndex(s => s.id === button.dataset.qaSlide), true); });
$('#editor-fields').addEventListener('input', event => {
  const target = event.target;
  if (target.tagName === 'SELECT') return;
  if (target.dataset.field) {
    active()[target.dataset.field] = target.value;
    const count = $(`[data-count="${target.dataset.field}"]`); if (count) count.textContent = `${target.value.length}/${target.maxLength}`;
  } else if (target.dataset.group) active()[target.dataset.group][+target.dataset.index][target.dataset.key] = target.value;
  else return;
  changed({ key: `${active().id}:${target.id}` });
});
$('#editor-fields').addEventListener('change', event => {
  const target = event.target; if (target.tagName !== 'SELECT') return;
  if (target.dataset.field === 'layout') {
    active().layout = target.value;
    const config = groupConfig[target.value]; if (config && !active()[config.key].length) active()[config.key] = makeSlide(target.value)[config.key];
    changed({ editor: true }); $('#edit-layout').focus();
  } else { if (target.dataset.field) active()[target.dataset.field] = target.value; else if (target.dataset.group) active()[target.dataset.group][+target.dataset.index][target.dataset.key] = target.value; changed(); }
});
$('#editor-fields').addEventListener('click', async event => {
  const remove = event.target.closest('[data-remove-row]'); const config = groupConfig[active().layout];
  if (remove && config) {
    const slide = active(), index = +remove.dataset.removeRow;
    if (await confirmChange(`Remove ${config.name.toLowerCase()}?`, 'This content will be removed from the slide. Export JSON first if you need a backup.', 'Remove')) { slide[config.key].splice(index, 1); changed({ editor: true }); }
  }
  if (event.target.closest('#add-row-button') && config && active()[config.key].length < config.max) { active()[config.key].push({ ...config.empty }); changed({ editor: true }); $(`#row-${active()[config.key].length - 1}-${config.fields[0][0]}`).focus(); }
});
$('#speaker-notes').addEventListener('input', event => { active().notes = event.target.value; recordChange(`${active().id}:notes`); markDirty(); });
$('#undo-button').addEventListener('click', () => travelHistory()); $('#redo-button').addEventListener('click', () => travelHistory(true));
$('#editor-fields').addEventListener('focusout', () => { historyKey = ''; });
$('#speaker-notes').addEventListener('blur', () => { historyKey = ''; });
for (const id of ['add-slide-button', 'add-slide-bottom']) $(`#${id}`).addEventListener('click', openLayoutChooser);
$('#layout-options').innerHTML = LAYOUTS.map(layout => `<button class="layout-option" data-layout="${layout}"><strong>${layoutNames[layout]}</strong><span>${layoutDescriptions[layout]}</span></button>`).join('');
$('#layout-options').addEventListener('click', event => { const button = event.target.closest('[data-layout]'); if (button) addSlide(button.dataset.layout); });
$('#duplicate-button').addEventListener('click', () => { if (deck.slides.length >= MAX_SLIDES) return; const copy = structuredClone(active()); copy.id = `s-${crypto.randomUUID()}`; deck.slides.splice(selected + 1, 0, copy); selected++; changed({ editor: true }); notify('Slide duplicated, including notes.'); });
$('#delete-button').addEventListener('click', async () => {
  if (deck.slides.length <= 1) return;
  if (await confirmChange('Delete this slide?', `“${active().title || 'Untitled'}” and its speaker notes will be removed.`, 'Delete slide')) { deck.slides.splice(selected, 1); selected = Math.min(selected, deck.slides.length - 1); changed({ editor: true }); notify('Slide deleted.'); }
});
function moveSlide(direction) { const to = selected + direction; if (to < 0 || to >= deck.slides.length) return; [deck.slides[selected], deck.slides[to]] = [deck.slides[to], deck.slides[selected]]; selected = to; changed({ editor: true }); }
$('#move-up-button').addEventListener('click', () => moveSlide(-1)); $('#move-down-button').addEventListener('click', () => moveSlide(1));
$('#deck-settings-button').addEventListener('click', () => {
  const form = $('#settings-form'); for (const key of ['title', 'subtitle', 'audience']) form.elements[key].value = deck[key]; form.elements.theme.value = deck.theme; $('#settings-dialog').showModal();
});
$('#settings-form').addEventListener('submit', event => { event.preventDefault(); const form = event.currentTarget; if (!form.elements.title.value.trim()) { form.elements.title.setCustomValidity('Enter a non-blank title.'); form.elements.title.reportValidity(); return; } for (const key of ['title', 'subtitle', 'audience', 'theme']) deck[key] = form.elements[key].value; $('#settings-dialog').close(); changed(); notify('Deck settings updated.'); });
$('#settings-form').elements.title.addEventListener('input', event => event.target.setCustomValidity(''));
$('#new-deck-button').addEventListener('click', () => { $('#settings-dialog').close(); openStarter('blank'); });
$('#save-button').addEventListener('click', () => saveNow().then(() => notify('Saved locally.')).catch(() => {}));
$('#export-json-button').addEventListener('click', () => { try { download(JSON.stringify(validateDeck(deck), null, 2) + '\n', 'application/json', 'json'); notify('Deck JSON exported, including speaker notes.'); } catch (issue) { error(issue.message); } });
$('#export-html-button').addEventListener('click', () => guarded(async () => { await saveNow(); const response = await request(`/api/export/html?deckId=${encodeURIComponent(deckId)}`); download(await response.text(), 'text/html', 'html'); notify('Offline presentation exported. Speaker notes excluded.'); }));
$('#print-button').addEventListener('click', async () => {
  const popup = window.open('about:blank', '_blank');
  if (!popup) { error('Allow pop-ups for Fielddeck to open the print view, or export HTML and print that file.'); return; }
  popup.opener = null;
  if (busy) { popup.close(); return; }
  await guarded(async () => { try { await saveNow(); popup.location.href = `/present?deckId=${encodeURIComponent(deckId)}`; notify('In the new window, choose Print / PDF. Enable background graphics.'); } catch (issue) { popup.close(); throw issue; } });
});
$('#import-button').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async event => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  await guarded(async () => {
    if (file.size > MAX_BYTES) throw new Error('Import must be 1 MiB or smaller.');
    const next = parseDeck(await file.text());
    if (await confirmChange('Replace the working deck?', `Import “${next.title}” (${next.slides.length} slides)? Only this deck's contents are replaced; other library decks are untouched. Undo is available in this window. Save a checkpoint or export JSON for durable recovery.`, 'Import deck')) { replaceDeck(next); notify(`Imported ${next.slides.length} slides.`); }
  });
});
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('#sample-button').addEventListener('click', () => { $('#help-dialog').close(); openStarter('sample'); });
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
function renderPresentation() {
  $('#present-canvas').innerHTML = renderSlide(deck.slides[presenting], presenting, deck.slides.length, deck.theme);
  $('#present-position').textContent = `${presenting + 1} / ${deck.slides.length}`;
  $('#present-notes').textContent = deck.slides[presenting].notes || 'No speaker notes for this slide.';
  $('#present-prev').disabled = presenting === 0; $('#present-next').disabled = presenting === deck.slides.length - 1;
}
function stepPresentation(delta) { presenting = Math.max(0, Math.min(deck.slides.length - 1, presenting + delta)); renderPresentation(); }
function openPresentation() { if (!deck) return; presenting = selected; $('#present-title').textContent = deck.title; $('#present-notes').hidden = true; $('#present-notes-button').setAttribute('aria-pressed', 'false'); renderPresentation(); $('#present-dialog').showModal(); $('#close-present-button').focus(); }
async function fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('#present-dialog').requestFullscreen(); } catch { notify('Fullscreen is unavailable in this browser. Presentation controls still work.'); } }
function toggleNotes() { $('#present-notes').hidden = !$('#present-notes').hidden; $('#present-notes-button').setAttribute('aria-pressed', String(!$('#present-notes').hidden)); }
$('#present-button').addEventListener('click', openPresentation);
$('#present-prev').addEventListener('click', () => stepPresentation(-1)); $('#present-next').addEventListener('click', () => stepPresentation(1));
$('#present-notes-button').addEventListener('click', toggleNotes); $('#fullscreen-button').addEventListener('click', fullscreen);
$('#close-present-button').addEventListener('click', () => $('#present-dialog').close());
$('#present-dialog').addEventListener('close', () => { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); });
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveNow().catch(() => {}); return; }
  const typing = /INPUT|TEXTAREA|SELECT/.test(event.target.tagName);
  if ($('#present-dialog').open) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (['ArrowRight', 'PageDown'].includes(event.key) || (event.key === ' ' && event.target.tagName !== 'BUTTON')) { event.preventDefault(); stepPresentation(1); }
    if (['ArrowLeft', 'PageUp'].includes(event.key)) { event.preventDefault(); stepPresentation(-1); }
    if (event.key === 'Home') { event.preventDefault(); presenting = 0; renderPresentation(); }
    if (event.key === 'End') { event.preventDefault(); presenting = deck.slides.length - 1; renderPresentation(); }
    if (event.key.toLowerCase() === 'n') { event.preventDefault(); toggleNotes(); }
    if (event.key.toLowerCase() === 'f') { event.preventDefault(); fullscreen(); }
    return;
  }
  if (!typing && !document.querySelector('dialog[open]') && (event.ctrlKey || event.metaKey)) {
    if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y') { event.preventDefault(); travelHistory(event.shiftKey || event.key.toLowerCase() === 'y'); }
    if (event.key === 'Enter') { event.preventDefault(); openPresentation(); }
  }
});
window.addEventListener('beforeunload', event => { if (generation !== savedGeneration) { event.preventDefault(); event.returnValue = ''; } });
const deckPath = (id = deckId) => `/api/decks/${encodeURIComponent(id)}`;
async function mutate(path, body, expected) {
  return (await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(expected ? { 'If-Match': expected } : {}) }, body: JSON.stringify(body) })).json();
}
function renderLibrary() {
  if (!library || library.migrationRequired) return;
  $('#deck-switcher').innerHTML = library.decks.map(item => `<option value="${e(item.id)}" ${item.id === deckId ? 'selected' : ''}>${e(item.title)}${item.archived ? ' · archived' : ''}</option>`).join('');
  $('#library-limits').textContent = `${library.decks.length} / 24 decks, including archives · 12 checkpoints per deck · 32 MiB workspace limit. No automatic deletion.`;
  $('#library-list').innerHTML = library.decks.map(item => `<div class="library-card"><div><strong>${e(item.id === deckId ? deck.title : item.title)}</strong><p>${item.archived ? 'Archived · read only' : 'Active'} · ${item.checkpointCount} checkpoints${item.id === deckId ? ' · open in this window' : ''}</p></div><div class="library-actions"><button data-open-deck="${e(item.id)}" aria-current="${item.id === deckId}">Open</button><button data-archive-deck="${e(item.id)}">${item.archived ? 'Unarchive' : 'Archive'}</button></div></div>`).join('');
}
async function refreshLibrary() {
  const next = await (await request('/api/workspace')).json();
  if (rendererRevision && next.rendererRevision !== rendererRevision) invalidateReport('Renderer changed; reload before review');
  const remote = next.decks?.find(item => item.id === deckId);
  if (report && remote && remote.revision !== revision) invalidateReport('Saved deck changed in another window');
  library = next; renderLibrary(); return next;
}
function adoptEntry(data, reset = true) {
  const nextDeck = validateDeck(data.deck), nextBrief = data.brief === null ? null : validateBrief(data.brief);
  clearTimeout(saveTimer); deck = nextDeck; brief = nextBrief; deckId = deck.id; revision = data.revision; archived = data.archived; checkpoints = data.checkpoints || [];
  generation = 0; savedGeneration = 0; selected = 0; invalidateReport('Deck switched');
  if (reset) { resetHistory(); report = null; $('#preflight-results').textContent = ''; invalidateReport(); }
  renderAll(); renderLibrary(); status(archived ? 'Archived · read only' : 'Saved locally'); clearError();
  try { sessionStorage.setItem('fielddeck-selected-deck', deckId); } catch {}
}
async function switchDeck(id) {
  return guarded(async () => {
    try {
      await saveNow();
      const data = await (await request(deckPath(id))).json();
      adoptEntry(data); await refreshLibrary(); $('#library-dialog').close();
    } finally { if (deckId) $('#deck-switcher').value = deckId; }
  });
}
$('#deck-switcher').addEventListener('change', event => switchDeck(event.target.value));
$('#library-button').addEventListener('click', () => guarded(async () => { await refreshLibrary(); $('#duplicate-deck-title').value = `${deck.title.slice(0, 130)} copy`; $('#library-dialog').showModal(); }));
$('#library-list').addEventListener('click', event => {
  const open = event.target.closest('[data-open-deck]'); if (open) { switchDeck(open.dataset.openDeck); return; }
  const button = event.target.closest('[data-archive-deck]'); if (!button) return;
  guarded(async () => {
    await saveNow(); const id = button.dataset.archiveDeck, item = library.decks.find(entry => entry.id === id);
    if (!await confirmChange(item.archived ? 'Unarchive this deck?' : 'Archive this deck?', item.archived ? 'The deck will be editable again.' : 'The deck and checkpoints remain in the library, read only until you unarchive it.', item.archived ? 'Unarchive' : 'Archive')) return;
    const data = await mutate(`${deckPath(id)}/archive`, { archived: !item.archived }, id === deckId ? revision : item.revision);
    if (id === deckId) { revision = data.revision; archived = data.archived; invalidateReport('Archive status changed'); status(archived ? 'Archived · read only' : 'Saved locally'); }
    await refreshLibrary(); notify(item.archived ? 'Deck unarchived.' : 'Deck archived; nothing deleted.');
  });
});
$('#duplicate-deck-form').addEventListener('submit', event => {
  event.preventDefault(); const title = $('#duplicate-deck-title').value.trim(); if (!title) return;
  guarded(async () => { await saveNow(); const data = await mutate(`${deckPath()}/duplicate`, { title }, revision); adoptEntry(data); await refreshLibrary(); $('#library-dialog').close(); notify('Independent deck duplicated.'); });
});
function openStarter(kind = 'fde-discovery-narrative') { if (busy || !deck) return; $('#starter-form').reset(); $('#starter-kind').value = kind; $('#starter-name').value = kind === 'sample' ? 'Northstar · fictional field notes' : ''; toggleStarterFields(); $('#starter-dialog').showModal(); }
function toggleStarterFields() { $('#starter-brief-fields').hidden = ['blank', 'sample'].includes($('#starter-kind').value); }
$('#starter-button').addEventListener('click', () => openStarter()); $('#starter-kind').addEventListener('change', toggleStarterFields);
function formBrief(form, skill) { return validateBrief({ version: 1, skill, ...Object.fromEntries(['audience', 'decision', 'constraints', 'evidenceGaps'].map(key => [key, form.elements[key].value])) }); }
$('#starter-form').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget, starter = form.elements.starter.value, title = form.elements.title.value.trim(); if (!title) return;
  guarded(async () => { const nextBrief = ['blank', 'sample'].includes(starter) ? null : formBrief(form, starter); await saveNow(); const data = await mutate('/api/decks', { title, starter, brief: nextBrief }); adoptEntry(data); await refreshLibrary(); $('#starter-dialog').close(); notify('New independent deck created. No model was called.'); });
});
$('#brief-button').addEventListener('click', () => {
  if (!deck || busy) return;
  const form = $('#brief-form'); form.elements.skill.value = brief?.skill || 'fde-discovery-narrative';
  for (const key of ['audience', 'decision', 'constraints', 'evidenceGaps']) form.elements[key].value = brief?.[key] || (key === 'audience' ? deck.audience : '');
  for (const element of form.elements) if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) element.disabled = archived;
  $('#brief-dialog').showModal();
});
function applyBriefForm() {
  if (archived) { if (!brief) throw new Error('Unarchive this deck to add a brief.'); return; }
  const next = formBrief($('#brief-form'), $('#brief-skill').value);
  if (JSON.stringify(next) !== JSON.stringify(brief)) { brief = next; recordChange(); markDirty(); }
}
$('#brief-form').addEventListener('submit', event => { event.preventDefault(); guarded(async () => { applyBriefForm(); await saveNow(); $('#brief-dialog').close(); notify('Agent brief saved with this deck.'); }); });
$('#export-brief-button').addEventListener('click', () => { try { applyBriefForm(); download(JSON.stringify(brief, null, 2) + '\n', 'application/json', 'brief.json'); notify('Brief JSON exported. No model called.'); } catch (issue) { error(issue.message); } });
$('#export-skill-button').addEventListener('click', () => guarded(async () => { applyBriefForm(); await saveNow(); const response = await request(`${deckPath()}/brief.zip?skill=${encodeURIComponent(brief.skill)}`); download(await response.arrayBuffer(), 'application/zip', 'skill.zip'); notify('Complete skill and brief exported as an inert ZIP. Review private notes before sharing.'); }));
function renderCheckpoints() {
  $('#checkpoint-list').innerHTML = checkpoints.length ? checkpoints.map(item => `<div class="library-card"><div><strong>${e(item.name)}</strong><p>${e(new Date(item.createdAt).toLocaleString())}</p></div><button data-preview-checkpoint="${e(item.id)}">Preview</button></div>`).join('') : '<p class="field-help">No checkpoints yet. Save a named milestone before a major change.</p>';
  $('#create-checkpoint-button').disabled = archived || checkpoints.length >= 12;
}
$('#checkpoints-button').addEventListener('click', () => guarded(async () => {
  await saveNow(); const data = await (await request(deckPath())).json();
  if (data.revision !== revision) throw new Error('Another window changed this deck. Export your edits and reload before working with checkpoints.');
  checkpoints = data.checkpoints; renderCheckpoints(); $('#checkpoints-dialog').showModal();
}));
$('#checkpoint-form').addEventListener('submit', event => {
  event.preventDefault(); const name = $('#checkpoint-name').value.trim(); if (!name) return;
  guarded(async () => { await saveNow(); const data = await mutate(`${deckPath()}/checkpoints`, { name }, revision); revision = data.revision; checkpoints = data.checkpoints; invalidateReport('Checkpoint revision changed'); renderCheckpoints(); $('#checkpoint-name').value = ''; await refreshLibrary(); notify('Named checkpoint saved.'); });
});
$('#checkpoint-list').addEventListener('click', event => {
  const button = event.target.closest('[data-preview-checkpoint]'); if (!button) return;
  guarded(async () => {
    checkpointPreview = await (await request(`${deckPath()}/checkpoints/${encodeURIComponent(button.dataset.previewCheckpoint)}`)).json();
    const preview = checkpointPreview, contents = validateDeck(preview.deck);
    $('#checkpoint-preview-title').textContent = preview.name;
    $('#checkpoint-preview-summary').textContent = `${contents.title} · ${contents.slides.length} slides · ${new Date(preview.createdAt).toLocaleString()}. Review every slide before restoring.`;
    $('#checkpoint-preview-slides').innerHTML = contents.slides.map((slide, index) => `<div class="checkpoint-slide">${renderSlide(slide, index, contents.slides.length, contents.theme)}</div>`).join('');
    $('#checkpoint-preview-details').textContent = JSON.stringify({ brief: preview.brief, notes: contents.slides.map(slide => ({ title: slide.title, notes: slide.notes })) }, null, 2);
    $('#checkpoint-preview-dialog').showModal();
  });
});
$('#restore-checkpoint-button').addEventListener('click', () => guarded(async () => {
  if (!checkpointPreview || archived) return;
  if (!await confirmChange('Restore this checkpoint?', `Replace the current contents and brief with “${checkpointPreview.name}”? Current edits will be saved first. This restore can be undone in this window; make another checkpoint for durable recovery.`, 'Restore checkpoint')) return;
  await saveNow();
  const data = await mutate(`${deckPath()}/checkpoints/${encodeURIComponent(checkpointPreview.id)}/restore`, { confirm: true }, revision);
  deck = validateDeck(data.deck); brief = data.brief; revision = data.revision; checkpoints = data.checkpoints; selected = 0;
  recordChange(); generation++; savedGeneration = generation; invalidateReport('Checkpoint restored'); renderAll(); renderCheckpoints(); await refreshLibrary();
  $('#checkpoint-preview-dialog').close(); $('#checkpoints-dialog').close(); status('Saved locally'); notify('Checkpoint restored. Undo remains available in this window.');
}));
async function contentHash(value) { const bytes = new TextEncoder().encode(JSON.stringify(value)); return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join(''); }
function renderReport() {
  $('#preflight-results').innerHTML = `<p class="preflight-summary">${report.slides.length} / ${report.slideCount} slides measured · ${report.issues.length} issues · ${e(new Date(report.createdAt).toLocaleString())}</p>` + (report.issues.length ? report.issues.map(issue => `<div class="qa-item"><span class="qa-mark" aria-hidden="true">!</span>${issue.slideId ? `<button data-preflight-slide="${e(issue.slideId)}">${e(issue.message)}</button>` : `<span>${e(issue.message)}</span>`}</div>`).join('') : '<p class="qa-empty">No measured or editorial issues found. Human review and print inspection are still required.</p>');
}
$('#review-all-button').addEventListener('click', () => guarded(async () => {
  await saveNow(); const workspace = await refreshLibrary();
  if (workspace.rendererRevision !== rendererRevision) throw new Error('Renderer changed since this page loaded. Reload before running a current preflight.');
  if (workspace.decks.find(item => item.id === deckId)?.revision !== revision) throw new Error('Another window changed this deck. Export your edits and reload before reviewing the latest saved revision.');
  await document.fonts.ready;
  const snapshot = validateDeck(deck), token = ++reviewToken, id = deckId, savedRevision = revision, stage = $('#preflight-stage');
  const issues = reviewDeck(snapshot), measurements = [];
  $('#preflight-status').textContent = 'Measuring every slide…'; $('#export-review-button').disabled = true;
  try {
    for (let index = 0; index < snapshot.slides.length; index++) {
      const slide = snapshot.slides[index]; stage.innerHTML = renderSlide(slide, index, snapshot.slides.length, snapshot.theme);
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (token !== reviewToken || id !== deckId) throw new Error('Deck changed during preflight. Run it again.');
      const measurement = measureSlideOverflow(stage.firstElementChild);
      if (!measurement || measurement.width !== 1600 || measurement.height !== 900) throw new Error('Could not measure the fixed 1600 × 900 canvas. No partial report will be published.');
      measurements.push({ slideId: slide.id, slideNumber: index + 1, ...measurement });
      if (measurement.issues.length) issues.push({ slideId: slide.id, code: 'overflow', severity: 'warning', message: `Slide ${index + 1}: measured overflow at 1600 × 900. Content crosses the footer or canvas. Split or shorten visible text; nothing was removed.` });
    }
    const hash = await contentHash(snapshot);
    if (token !== reviewToken) throw new Error('Deck changed during preflight. Run it again.');
    report = { version: 1, deckId: id, revision: savedRevision, contentHash: `sha256:${hash}`, rendererRevision, createdAt: new Date().toISOString(), viewport: { width: 1600, height: 900 }, slideCount: snapshot.slides.length, slides: measurements, issues, stale: false, limits: { maxSlides: MAX_SLIDES, maxDeckBytes: MAX_BYTES, allSlidesMeasured: true, scope: 'Editorial heuristics and fixed-size DOM measurement only; not factual validation or proof of print correctness. No content truncated.' } };
    renderReport(); $('#preflight-status').textContent = `Current · ${measurements.length} slides reviewed`; $('#preflight-status').dataset.state = 'current'; $('#export-review-button').disabled = false;
  } catch (issue) { invalidateReport('Review incomplete'); throw issue; }
  finally { stage.replaceChildren(); }
}));
$('#preflight-results').addEventListener('click', event => { const button = event.target.closest('[data-preflight-slide]'); if (button) selectSlide(deck.slides.findIndex(slide => slide.id === button.dataset.preflightSlide), true); });
$('#export-review-button').addEventListener('click', () => guarded(async () => { await refreshLibrary(); if (!report || report.stale || report.deckId !== deckId) throw new Error('This preflight is stale. Review all slides again before downloading.'); download(JSON.stringify(report, null, 2) + '\n', 'application/json', 'preflight.json'); }));
$('#migrate-button').addEventListener('click', () => guarded(async () => {
  if (!await confirmChange('Back up and migrate the saved deck?', 'The original deck.json stays unchanged. A byte-for-byte deck.pre-migration.json recovery copy is written before workspace.json. Continue only if you want to create this library.', 'Back up & migrate')) return;
  await mutate('/api/workspace/migrate', { confirm: true }, library.legacyRevision); await init(); notify('Original saved deck preserved; library ready.');
}));
async function init() {
  try {
    library = await (await request('/api/workspace')).json(); rendererRevision = library.rendererRevision;
    $('#migration-panel').hidden = !library.migrationRequired;
    for (const node of document.querySelectorAll('main button, main input, main select, main textarea')) node.disabled = library.migrationRequired && node.id !== 'migrate-button';
    if (library.migrationRequired) { $('#migration-description').textContent = `Saved deck: ${library.legacyTitle}. No migration has run yet.`; status('Migration needs confirmation', 'dirty'); return; }
    let chosen; try { chosen = sessionStorage.getItem('fielddeck-selected-deck'); } catch {}
    if (!library.decks.some(item => item.id === chosen)) chosen = library.primaryDeckId;
    adoptEntry(await (await request(deckPath(chosen))).json()); renderLibrary();
  } catch (issue) { status('Workspace unavailable', 'error'); error(`Could not open the workspace. ${issue.message} Check that the Fielddeck server is running, then reload.`); for (const button of document.querySelectorAll('main button')) button.disabled = true; }
}
window.addEventListener('focus', () => { if (deck && !busy) refreshLibrary().catch(() => {}); });
document.fonts.addEventListener('loadingdone', () => { if (report) invalidateReport('Fonts changed'); });
const previewObserver = new ResizeObserver(() => { if (deck) renderQA(); });
previewObserver.observe($('#preview'));
document.fonts.ready.then(() => { if (deck) renderQA(); });
init();
