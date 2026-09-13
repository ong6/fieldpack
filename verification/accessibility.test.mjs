import { test } from 'node:test';
import assert from 'node:assert/strict';
import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
import { startApp, launchBrowser, ARTIFACTS, noHorizontalOverflow } from './harness.mjs';

for (const name of ['skillforge', 'proofpack']) {
  test(`${name}: populated workspace route accessibility and mobile layout`, { timeout: 120000 }, async () => {
    const app = await startApp(name);
    const browser = await launchBrowser();
    const findings = [];
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      await page.goto(app.url);
      await page.locator('h1').waitFor();
      if (name === 'proofpack') {
        await page.getByRole('button', { name: 'Explore the fictional sample' }).click();
        await page.locator('#confirm-proceed').click();
        await page.getByText('Good work deserves good proof.').waitFor();
      } else {
        await page.locator('[data-action="select"]').first().click();
      }
      const routes = name === 'proofpack' ? ['library', 'overview', 'charter', 'criteria', 'evidence', 'coverage', 'risks', 'decisions', 'checklist', 'handover', 'help'] : ['discover', 'profiles', 'compose', 'compare', 'evidence', 'library', 'workspace', 'help'];
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        for (const route of routes) {
          await page.evaluate(route => { location.hash = route; }, route);
          await page.waitForFunction(route => [...document.querySelectorAll('[aria-current="page"]')].some(a => a.getAttribute('href') === '#' + route) || (route === 'help' && document.querySelector('h1')?.textContent.includes('Know the tools')), route);
          await page.emulateMedia({ reducedMotion: 'reduce' });
          await page.evaluate(() => Promise.all(document.getAnimations().map(a => a.finished.catch(() => {}))));
          const dimensions = await noHorizontalOverflow(page);
          if (dimensions.content > dimensions.width) findings.push({ route, width, overflow: dimensions });
          const result = await new AxeBuilder({ page }).exclude('.preview-frame').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
          for (const violation of result.violations) findings.push({ route, width, id: violation.id, nodes: violation.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) });
        }
      }
      await writeFile(ARTIFACTS + '/' + name + '-route-accessibility.json', JSON.stringify(findings, null, 2));
      assert.deepEqual(findings.map(f => ({ route: f.route, width: f.width, id: f.id, overflow: f.overflow, targets: f.nodes?.map(n => n.target) })), []);
    } finally { await browser.close(); await app.close(); }
  });
}
