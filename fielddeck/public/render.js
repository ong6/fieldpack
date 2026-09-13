import { validateDeck } from './model.js';
export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const e = escapeHTML;
const badge = label => `<span class="claim claim-${e(label)}">${e(label)}</span>`;
export function layoutClasses(slide) {
  const classes = [];
  const titleLines = slide.title.split('\n').length;
  if (slide.layout === 'title') {
    if (slide.title.length > 36 || slide.subtitle.length > 150 || titleLines > 2) classes.push('cover-compact');
    if (slide.title.length > 80 || slide.subtitle.length > 240 || titleLines > 3) classes.push('cover-dense');
  } else {
    const crowded = (slide.layout === 'findings' && slide.points.length > 3) || (slide.layout === 'next-steps' && slide.actions.length > 3) || (slide.layout === 'results' && slide.metrics.length > 3) || (slide.layout === 'architecture' && slide.nodes.length > 3) || (slide.layout === 'comparison' && slide.columns.length > 2);
    if (crowded || slide.title.length > 52 || slide.subtitle.length > 130) classes.push('density-compact');
    if (slide.title.length > 90 || titleLines > 2) classes.push('heading-long');
  }
  if (slide.layout === 'findings' && slide.points.length > 3) classes.push(slide.points.length === 4 ? 'findings-four' : 'findings-many');
  if (slide.layout === 'next-steps' && slide.actions.length > 3) classes.push('actions-compact');
  if (slide.layout === 'architecture' && slide.nodes.length > 3) classes.push('architecture-compact');
  if (slide.layout === 'comparison' && slide.columns.length > 2) classes.push('comparison-compact');
  return classes.join(' ');
}
export function renderSlide(slide, index, total, theme = 'navy') {
  let body = '';
  switch (slide.layout) {
    case 'title': body = '<div class="cover-art" aria-hidden="true"><i></i><i></i><i></i><i></i></div>'; break;
    case 'findings': body = `<div class="finding-grid">${slide.points.map((p, i) => `<div class="finding"><span class="item-number">${String(i + 1).padStart(2, '0')}</span>${badge(p.labelType)}<p>${e(p.text)}</p>${p.source ? `<small>${e(p.source)}</small>` : ''}</div>`).join('')}</div>`; break;
    case 'architecture': body = `<div class="architecture-flow" aria-label="Information flow from left to right">${slide.nodes.map((n, i) => `<div class="architecture-node"><span class="item-number">${String(i + 1).padStart(2, '0')}</span><h3>${e(n.name)}</h3><p>${e(n.detail)}</p></div>${i < slide.nodes.length - 1 ? '<span class="flow-arrow" aria-label="flows to">→</span>' : ''}`).join('')}</div>`; break;
    case 'comparison': body = `<div class="comparison-grid">${slide.columns.map((c, i) => `<div class="comparison-column"><span class="item-number">OPTION ${String(i + 1).padStart(2, '0')}</span><h3>${e(c.heading)}</h3><p>${e(c.body)}</p></div>`).join('')}</div>`; break;
    case 'results': body = `<div class="metrics-grid">${slide.metrics.map(m => `<div class="metric ${m.value.length > 18 ? 'metric-value-text' : m.value.length > 8 ? 'metric-value-long' : ''}"><strong>${e(m.value)}</strong><p>${e(m.label)}</p>${m.source ? `<small>${e(m.source)}</small>` : ''}</div>`).join('')}</div>`; break;
    case 'next-steps': body = `<ol class="action-list">${slide.actions.map((a, i) => `<li><span class="item-number">${String(i + 1).padStart(2, '0')}</span><strong>${e(a.text)}</strong><span>${e(a.owner)}</span><span class="action-date">${e(a.date)}</span></li>`).join('')}</ol>`; break;
  }
  return `<article class="slide theme-${e(theme)} layout-${e(slide.layout)} ${layoutClasses(slide)}" aria-label="Slide ${index + 1}: ${e(slide.title)}"><div class="slide-top"><span class="eyebrow">${e(slide.eyebrow || 'FIELDDECK / FIELD NOTES')}</span>${badge(slide.label)}</div><div class="slide-heading"><h2>${e(slide.title)}</h2>${slide.subtitle ? `<p class="slide-subtitle">${e(slide.subtitle)}</p>` : ''}</div><div class="slide-body">${body}</div><footer class="slide-footer"><span>${e(slide.source || 'Source not yet specified')}</span><span>${String(index + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}</span></footer></article>`;
}
export function measureSlideOverflow(element) {
  const outer = element.getBoundingClientRect();
  if (!outer.width || !outer.height) return null;
  const footer = element.querySelector('.slide-footer').getBoundingClientRect();
  const issues = [];
  const tolerance = Math.max(1, outer.width / 1000);
  const content = element.querySelectorAll('.slide-top,.slide-heading,h2,h3,p,small,.metric strong,.action-list li,.finding,.architecture-node,.comparison-column');
  for (const node of content) {
    const bounds = node.getBoundingClientRect();
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(node);
    const textBounds = node.textContent.trim() ? range.getBoundingClientRect() : bounds;
    const right = Math.max(bounds.right, textBounds.right);
    const left = Math.min(bounds.left, textBounds.left);
    const bottom = Math.max(bounds.bottom, textBounds.bottom);
    if (bottom > footer.top + tolerance || right > outer.right + tolerance || left < outer.left - tolerance) issues.push({ text: node.textContent.slice(0, 80), bottom: Math.round(bottom), footerTop: Math.round(footer.top) });
  }
  const footerRange = element.ownerDocument.createRange();
  footerRange.selectNodeContents(element.querySelector('.slide-footer'));
  const footerText = footerRange.getBoundingClientRect();
  if (footer.bottom > outer.bottom + tolerance || footerText.bottom > outer.bottom + tolerance || footerText.right > outer.right + tolerance) issues.push({ text: 'Footer exceeds canvas' });
  if (Math.abs(outer.width / outer.height - 16 / 9) > .03) issues.push({ text: 'Content expanded the 16:9 canvas' });
  return { width: Math.round(outer.width), height: Math.round(outer.height), issues };
}
export function exportHTML(input, slideCSS, presentationJS) {
  const deck = validateDeck(input);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><title>${e(deck.title)} — Fielddeck</title><style>${slideCSS}</style></head>
<body class="export-page"><header class="export-toolbar"><strong>${e(deck.title)}</strong><span id="present-counter" aria-live="polite"></span><button id="prev-slide" type="button">Previous</button><button id="next-slide" type="button">Next</button><button id="toggle-overview" type="button">Overview</button><button id="print-deck" type="button">Print / PDF</button></header><main id="export-slides">${deck.slides.map((s, i) => `<section class="export-slide">${renderSlide(s, i, deck.slides.length, deck.theme)}</section>`).join('')}</main><footer class="export-hint">← → to navigate · Home / End · O overview · Esc overview · Print to save as PDF. Speaker notes are intentionally excluded.</footer><script>${presentationJS}</script></body></html>`;
}
