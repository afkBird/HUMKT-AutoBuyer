const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const required = ['main.ts', 'preload.ts', 'worker.ts'];
const ignored = new Set(['node_modules', '.git', 'dist', 'release', '.cache']);

function hasSources(dir) {
  return required.every(name => fs.existsSync(path.join(dir, name)) && fs.statSync(path.join(dir, name)).isFile());
}

const target = path.join(root, 'src');
if (hasSources(target)) {
  console.log('[source-check] Found TypeScript sources in ./src');
  process.exit(0);
}

const candidates = [];
function walk(dir, depth = 0) {
  if (depth > 5) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  if (hasSources(dir)) candidates.push(dir);
  for (const entry of entries) {
    if (!entry.isDirectory() || ignored.has(entry.name)) continue;
    walk(path.join(dir, entry.name), depth + 1);
  }
}
walk(root);

if (candidates.length === 0) {
  const top = fs.readdirSync(root, { withFileTypes: true })
    .map(e => `${e.isDirectory() ? '[DIR] ' : '[FILE]'} ${e.name}`)
    .join('\n');
  console.error('[source-check] ERROR: main.ts, preload.ts and worker.ts were not found.');
  console.error('[source-check] Expected: <repository-root>/src/main.ts, preload.ts, worker.ts');
  console.error('[source-check] Repository root contents:\n' + top);
  console.error('[source-check] Upload the CONTENTS of the project folder, including the src folder. Do not upload the ZIP itself or an outer wrapper folder.');
  process.exit(2);
}

candidates.sort((a, b) => a.length - b.length);
const source = candidates[0];
console.warn(`[source-check] Sources were nested at ${path.relative(root, source)}; normalizing to ./src`);
if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(source, target, { recursive: true });
console.log('[source-check] Source normalization completed.');
