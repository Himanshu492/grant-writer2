// Packs the built UI (dist/client) into one JSON module so the Worker can serve it itself.
// The whole portal then deploys as a single Worker script - no separate asset upload step.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'dist', 'client');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
};
const TEXT = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt']);
const files = {};
(function walk(d) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) { walk(p); continue; }
    const ext = extname(name);
    const text = TEXT.has(ext);
    files['/' + relative(dir, p).split('\\').join('/')] = {
      type: TYPES[ext] ?? 'application/octet-stream',
      body: readFileSync(p).toString(text ? 'utf8' : 'base64'),
      base64: !text,
    };
  }
})(dir);
if (!files['/index.html']) throw new Error('dist/client/index.html is missing - run vite build first');
writeFileSync(join(root, 'src', 'worker', 'client.generated.json'), JSON.stringify(files));
console.log(`Packed ${Object.keys(files).length} UI files into the Worker`);
