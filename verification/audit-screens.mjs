import AxeBuilder from '@axe-core/playwright';
import { writeFile } from 'node:fs/promises';
import { startApp, launchBrowser, ARTIFACTS, noHorizontalOverflow } from './harness.mjs';
const browser = await launchBrowser();
try {
  for (const name of ['skillforge', 'proofpack']) {
    const app = await startApp(name);
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(app.url);
      await page.locator('h1').waitFor();
      if (name === 'proofpack') {
        await page.getByRole('button', { name: 'Explore the fictional sample' }).click();
        await page.locator('#confirm-proceed').click();
        await page.getByText('Good work deserves good proof.').waitFor();
      }
      const desktop = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      await writeFile(ARTIFACTS + '/' + name + '-desktop-accessibility.json', JSON.stringify(desktop.violations, null, 2));
      await page.screenshot({ path: ARTIFACTS + '/' + name + '-desktop.png', fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: ARTIFACTS + '/' + name + '-mobile.png', fullPage: true });
      const mobile = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      await writeFile(ARTIFACTS + '/' + name + '-mobile-accessibility.json', JSON.stringify(mobile.violations, null, 2));
      console.log(name, JSON.stringify({ errors, overflow: await noHorizontalOverflow(page), desktop: desktop.violations.map(v => ({ id: v.id, nodes: v.nodes.slice(0, 15).map(n => n.target), total: v.nodes.length })), mobile: mobile.violations.map(v => ({ id: v.id, count: v.nodes.length })) }));
      await context.close();
    } finally { await app.close(); }
  }
} finally { await browser.close(); }
