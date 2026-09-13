import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.dirname(fileURLToPath(import.meta.url));
const products = ['fielddeck', 'skillforge', 'proofpack'];
function run(command, args, cwd = root, capture = false) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  if (r.error || r.status !== 0) throw new Error(r.error?.message || r.stderr || `${command} failed with exit ${r.status}`);
  return r.stdout?.trim();
}
function doctor() {
  const checks = products.map(name => {
    const location = path.join(root, name);
    if (!existsSync(path.join(location, '.git'))) throw new Error(`${name}: submodule missing. Clone with --recurse-submodules, or run git submodule update --init after authenticating to private ong6 repositories.`);
    const pin = run('git', ['ls-tree', 'HEAD', '--', name], root, true).split(/\s+/)[2];
    const actual = run('git', ['rev-parse', 'HEAD'], location, true);
    if (pin !== actual) throw new Error(`${name}: checkout ${actual} does not match suite pin ${pin}. Preserve local work before updating.`);
    return { product: name, commit: actual, dependenciesInstalled: existsSync(path.join(location, 'node_modules')) };
  });
  console.log(JSON.stringify({ ok: true, node: process.version, products: checks }, null, 2));
}
try {
  switch (process.argv[2] || 'help') {
    case 'help': console.log(`Fieldwork suite integration home\n\nClone: git clone --recurse-submodules https://github.com/ong6/fieldwork-suite.git\nPrivate repository access is required for all three products.\n\nnpm run setup           Install pinned dependencies; does not alter agent settings\nnpm run browser:install Explicitly install Chromium for rendering and UI tests\nnpm run doctor          Verify checked-out commits match the suite pins\nnpm run test:products   Run each independent product's checks\nnpm test                Run cross-product, packaging, accessibility and browser checks\n\nUse each product directly with node PRODUCT/agent/cli.mjs commands.\nSelect an explicit --workspace outside this checkout. Use init once and setup\nto print MCP configuration. Repo-local skills live in PRODUCT/skills/.\nSkillforge delegates model execution to the host; no paid calls run automatically.\nProofpack agent proposals do not count as human approval.\nKeep private backups before recovery. Never discard dirty submodule work.\n\nTo upgrade a product, review and commit its new gitlink in this suite.\nThe integration contract tests use the actual pinned producer and consumer.`); break;
    case 'doctor': doctor(); break;
    case 'setup': doctor(); for (const name of [...products, 'verification']) run('npm', ['ci', '--ignore-scripts'], path.join(root, name)); break;
    default: throw new Error('Unknown command; use npm run help.');
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
