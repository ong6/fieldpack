import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT } from '../service.mjs';
import { renderSlide, measureSlideOverflow } from '../public/render.js';
import { reviewDeck } from '../public/model.js';
import { fingerprint, fault } from './workspace.mjs';
export async function render(snapshot, { format, slideNumber }) {
  const css = await readFile(path.join(ROOT, 'public/slide.css'), 'utf8');
  const renderer = await readFile(path.join(ROOT, 'public/render.js'), 'utf8');
  let browser;
  try { browser = await chromium.launch(); } catch { throw fault('BROWSER_UNAVAILABLE', 'Chromium unavailable. Run npm run browser:install in the Fielddeck package (explicit download), or configure PLAYWRIGHT_BROWSERS_PATH.'); }
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    await page.route('**/*', route => route.abort());
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}\nhtml,body{margin:0;width:1600px}.slide{width:1600px!important;height:900px!important;break-after:page}@page{size:1600px 900px;margin:0}</style>${snapshot.deck.slides.map((s, i) => renderSlide(s, i, snapshot.deck.slides.length, snapshot.deck.theme)).join('')}`);
    await page.evaluate(() => document.fonts.ready);
    const slides = await page.evaluate(source => { const measure = new Function(`return (${source})`)(); return [...document.querySelectorAll('.slide')].map((element, index) => ({ slideNumber: index + 1, ...measure(element) })); }, measureSlideOverflow.toString());
    if (slides.length !== snapshot.deck.slides.length || slides.some(s => s.width !== 1600 || s.height !== 900)) throw fault('RENDER_INCOMPLETE', 'Could not measure every slide at 1600x900.');
    const report = { version: 1, deckId: snapshot.deck.id, revision: snapshot.revision, contentHash: fingerprint(snapshot.deck), rendererHash: fingerprint(css + renderer), createdAt: new Date().toISOString(), viewport: { width: 1600, height: 900 }, slides, issues: [...reviewDeck(snapshot.deck), ...slides.filter(s => s.issues.length).map(s => ({ slideNumber: s.slideNumber, code: 'overflow', message: 'Measured overflow; split or shorten content.' }))], scope: 'Measured fit and editorial checks; no factual verification or content removal.' };
    if (format === 'preflight') return { report };
    if (format === 'png' && slideNumber > slides.length) throw fault('NOT_FOUND', 'Slide number exceeds deck length.');
    const bytes = format === 'pdf' ? await page.pdf({ preferCSSPageSize: true, printBackground: true }) : await page.locator('.slide').nth(slideNumber - 1).screenshot();
    return { report, artifact: { filename: `${snapshot.deck.id}.${format}`, mediaType: format === 'pdf' ? 'application/pdf' : 'image/png', bytes: bytes.length, sha256: fingerprint(bytes), base64: bytes.toString('base64') } };
  } finally { await browser.close(); }
}
