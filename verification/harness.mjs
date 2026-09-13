import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const PROJECTS = path.dirname(ROOT);
export const ARTIFACTS = path.join(ROOT, 'artifacts');

export async function launchBrowser() {
  const libraries = path.join(ROOT, 'browser-libs/usr/lib/x86_64-linux-gnu');
  return chromium.launch({ env: { ...process.env, LD_LIBRARY_PATH: [libraries, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } });
}

export async function startApp(name) {
  const directory = path.join(PROJECTS, name);
  await mkdir(path.join(directory, 'data'), { recursive: true });
  await mkdir(ARTIFACTS, { recursive: true });
  const data = await mkdtemp(path.join(directory, 'data/browser-test-'));
  const filename = name === 'skillforge' ? 'server.mjs' : 'server.js';
  const module = await import(path.join(directory, filename));
  const result = await module.createApp({ dataDir: data, dataFile: path.join(data, 'deck.json'), directory: data, dataPath: path.join(data, 'state.json') });
  const server = result.server || result;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    data,
    server,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(data, { recursive: true, force: true });
    },
  };
}

export async function download(page, click, filename) {
  const ready = page.waitForEvent('download');
  await click();
  const file = await ready;
  const destination = path.join(ARTIFACTS, filename || file.suggestedFilename());
  await file.saveAs(destination);
  return destination;
}

export async function noHorizontalOverflow(page) {
  return page.evaluate(() => ({ width: window.innerWidth, content: document.documentElement.scrollWidth }));
}
