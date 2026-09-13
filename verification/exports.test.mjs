import { test } from 'node:test';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { validateDeck, THEMES } from '../fielddeck/public/model.js';
import { exportHTML, measureSlideOverflow } from '../fielddeck/public/render.js';
import { startApp, launchBrowser, ARTIFACTS, ROOT } from './harness.mjs';

test('Proofpack customer document: privacy, accessible report and no external requests', { timeout: 60000 }, async () => {
  const app = await startApp('proofpack');
  const browser = await launchBrowser();
  try {
    const state = await (await fetch(app.url + '/api/project')).json();
    const result = await fetch(app.url + '/api/demo', { method: 'POST', headers: { Origin: app.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'REPLACE', revision: state.project.revision }) });
    assert.equal(result.status, 200);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const external = [];
    page.on('request', request => { if (!request.url().startsWith(app.url)) external.push(request.url()); });
    await page.goto(app.url + '/handover');
    const content = await page.content();
    for (const privateText of ['Internal delivery margin check', 'Internal support estimate', 'Support scope may expand', 'prepare the escalation rehearsal']) assert.ok(!content.includes(privateText), privateText);
    assert.ok(content.includes('FICTIONAL'));
    await page.screenshot({ path: ARTIFACTS + '/proofpack-customer-report.png', fullPage: true });
    const resultAudit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    await writeFile(ARTIFACTS + '/proofpack-export-accessibility.json', JSON.stringify(resultAudit.violations, null, 2));
    assert.deepEqual(resultAudit.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), []);
    assert.deepEqual(external, []);
  } finally { await browser.close(); await app.close(); }
});

test('Proofpack to Fielddeck: customer-safe deck imports, fits and exports offline', { timeout: 120000 }, async () => {
  const proofpack = await startApp('proofpack');
  const fielddeck = await startApp('fielddeck');
  const browser = await launchBrowser();
  try {
    const initial = await (await fetch(proofpack.url + '/api/project')).json();
    const demo = await fetch(proofpack.url + '/api/demo', { method: 'POST', headers: { Origin: proofpack.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'REPLACE', revision: initial.project.revision }) });
    assert.equal(demo.status, 200);
    const response = await fetch(proofpack.url + '/api/export/fielddeck');
    assert.equal(response.status, 200);
    const source = await response.text();
    const deck = validateDeck(JSON.parse(source));
    for (const privateText of ['Internal delivery margin check', 'Internal support estimate', 'Support scope may expand', 'prepare the escalation rehearsal']) assert.ok(!source.includes(privateText), privateText);
    assert.ok(source.includes('FICTIONAL'));
    assert.ok(source.includes('1m 42s') || source.includes('102 seconds'));
    assert.ok(source.includes('Operator access is not approved'));
    assert.ok(source.includes('re-review') || source.includes('unverified'));
    assert.ok(deck.slides.some(s => s.layout === 'next-steps' && s.actions.length));
    await writeFile(ARTIFACTS + '/proofpack-readout.fielddeck.json', source);
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(fielddeck.url);
    await page.locator('#edit-title').waitFor();
    await page.locator('#import-file').setInputFiles({ name: 'pilot-readout.json', mimeType: 'application/json', buffer: Buffer.from(source) });
    await page.locator('#confirm-accept').click();
    await page.waitForFunction(total => document.querySelectorAll('#slide-list > li').length === total, deck.slides.length);
    await page.locator('#save-button').click();
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === 'Saved locally');
    assert.equal(await page.locator('#edit-title').inputValue(), deck.slides[0].title);
    const css = await readFile(ROOT + '/../fielddeck/public/slide.css', 'utf8');
    const script = await readFile(ROOT + '/../fielddeck/public/presentation.js', 'utf8');
    const rendered = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
    const problems = [];
    for (const theme of THEMES) {
      await rendered.setContent(exportHTML({ ...deck, theme }, css, script));
      for (let i = 0; i < deck.slides.length; i++) {
        if (i) await rendered.locator('#next-slide').click();
        const measurement = await rendered.locator('.export-slide.active .slide').evaluate(measureSlideOverflow);
        if (measurement.issues.length) problems.push({ theme, slide: i + 1, title: deck.slides[i].title, ...measurement });
      }
    }
    await writeFile(ARTIFACTS + '/proofpack-readout-layout-check.json', JSON.stringify(problems, null, 2));
    assert.deepEqual(problems, []);
    await writeFile(ARTIFACTS + '/proofpack-readout.html', exportHTML(deck, css, script));
    await rendered.setContent(exportHTML(deck, css, script));
    await rendered.screenshot({ path: ARTIFACTS + '/proofpack-readout.png', fullPage: true });
    await rendered.pdf({ path: ARTIFACTS + '/proofpack-readout.pdf', printBackground: true, preferCSSPageSize: true });
  } finally { await browser.close(); await proofpack.close(); await fielddeck.close(); }
});
