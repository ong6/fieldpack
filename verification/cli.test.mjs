import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { PROJECTS, launchBrowser } from './harness.mjs';

for (const [name, port] of [['fielddeck', 4311], ['skillforge', 4312], ['proofpack', 4313]]) {
  test(`${name}: documented CLI starts at its local URL and serves the browser`, { timeout: 20000 }, async () => {
    const executable = name === 'skillforge' ? 'server.mjs' : 'server.js';
    const project = path.join(PROJECTS, name);
    await mkdir(path.join(project, 'data'), { recursive: true });
    const isolated = await mkdtemp(path.join(project, 'data/cli-test-'));
    for (const entry of await readdir(project)) {
      if (['data', 'test', 'node_modules', '.git'].includes(entry)) continue;
      await cp(path.join(project, entry), path.join(isolated, entry), { recursive: true });
    }
    const child = spawn(process.execPath, [path.join(isolated, executable)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const ready = new Promise((resolve, reject) => {
      child.stdout.on('data', b => { output += b; if (output.includes(`http://127.0.0.1:${port}`)) resolve(); });
      child.stderr.on('data', b => { output += b; });
      child.on('error', reject);
      child.on('exit', code => reject(new Error(`Server exited ${code}: ${output}`)));
    });
    let browser;
    try {
      await ready;
      browser = await launchBrowser();
      const page = await browser.newPage();
      const response = await page.goto(`http://127.0.0.1:${port}`);
      assert.equal(response.status(), 200);
      await page.locator('h1').waitFor();
      assert.ok(!(await page.locator('h1').innerText()).includes('Could not open'));
    } finally {
      if (browser) await browser.close();
      if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGINT'); await exited; }
      await rm(isolated, { recursive: true, force: true });
    }
  });
}
