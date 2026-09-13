import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { THEMES, validateDeck, visibleText } from '../fielddeck/public/model.js';
import { exportHTML, measureSlideOverflow } from '../fielddeck/public/render.js';
import { launchBrowser, ARTIFACTS, ROOT } from './harness.mjs';

for (const name of ['pilot-readout', 'discovery', 'architecture']) {
  test(`${name}: independently generated skill deck imports and renders every slide`, { timeout: 60000 }, async () => {
    const deck = validateDeck(JSON.parse(await readFile(ROOT + '/' + name + '-trial.json', 'utf8')));
    assert.ok(deck.slides.length >= 5 && deck.slides.length <= 7);
    assert.ok(deck.slides.every(s => s.source && s.notes));
    const visible = deck.slides.map(visibleText).join('\n');
    if (name === 'pilot-readout') { assert.match(visible, /120/); assert.match(visible, /240/); assert.match(visible, /not expand|do not expand/i); assert.match(visible, /review.*incomplete|incomplete.*review|review.*not completed/i); }
    if (name === 'discovery') { assert.match(visible, /\$1m.*unsupported|unsupported.*\$1m/i); assert.match(visible, /two-week/); assert.match(visible, /engineering/i); }
    if (name === 'architecture') { assert.match(visible, /unapproved|not approved/i); assert.match(visible, /deny/i); assert.match(visible, /permissions/i); }
    const css = await readFile(ROOT + '/../fielddeck/public/slide.css', 'utf8');
    const script = await readFile(ROOT + '/../fielddeck/public/presentation.js', 'utf8');
    const html = exportHTML(deck, css, script);
    const htmlPath = ARTIFACTS + '/' + name + '-trial.html';
    await writeFile(htmlPath, html);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
      await page.goto('file://' + htmlPath);
      const problems = [];
      for (let i = 0; i < deck.slides.length; i++) {
        if (i > 0) await page.locator('#next-slide').click();
        assert.equal(await page.locator('#present-counter').innerText(), `${i + 1} / ${deck.slides.length}`);
        const measurement = await page.locator('.export-slide.active .slide').evaluate(slide => {
          const outer = slide.getBoundingClientRect();
          const footer = slide.querySelector('.slide-footer').getBoundingClientRect();
          const issues = [];
          for (const element of slide.querySelectorAll('h2,h3,p,small,.metric strong,.action-list li,.slide-heading,.finding,.architecture-node,.comparison-column')) {
            const b = element.getBoundingClientRect();
            if (b.bottom > Math.min(footer.top, outer.bottom) + 1 || b.right > outer.right + 1 || b.left < outer.left - 1 || element.scrollWidth > element.clientWidth + 2) issues.push({ tag: element.tagName, class: element.className, text: element.textContent.slice(0, 90), bottom: b.bottom, footerTop: footer.top, overflowX: element.scrollWidth - element.clientWidth, overflowY: element.scrollHeight - element.clientHeight });
          }
          return { width: outer.width, height: outer.height, ratio: outer.width / outer.height, issues };
        });
        if (Math.abs(measurement.ratio - 16 / 9) > 0.03 || measurement.issues.length) problems.push({ slide: i + 1, ...measurement });
        await page.screenshot({ path: ARTIFACTS + '/' + name + '-slide-' + (i + 1) + '.png' });
      }
      await writeFile(ARTIFACTS + '/' + name + '-layout-check.json', JSON.stringify(problems, null, 2));
      assert.deepEqual(problems, []);
      await page.pdf({ path: ARTIFACTS + '/' + name + '-trial.pdf', printBackground: true, preferCSSPageSize: true });
      for (const width of [960, 1920]) {
        await page.setViewportSize({ width, height: 1200 });
        for (const theme of THEMES) {
          await page.setContent(exportHTML({ ...deck, theme }, css, script));
          for (let i = 0; i < deck.slides.length; i++) {
            if (i > 0) await page.locator('#next-slide').click();
            const result = await page.locator('.export-slide.active .slide').evaluate(measureSlideOverflow);
            assert.deepEqual(result.issues, [], JSON.stringify({ name, theme, width, slide: i + 1, result }));
          }
        }
      }
    } finally { await browser.close(); }
  });
}
