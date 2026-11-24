// Bundles the verified grant files in data/grants/*.json into one JSON module the Worker imports.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'data', 'grants');
const grants = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const g = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  if (!g.id || !g.title) throw new Error(`${f}: missing id or title`);
  if (!Array.isArray(g.questions)) g.questions = [];
  for (const q of g.questions) if (typeof q.text !== 'string' || !q.text.trim()) throw new Error(`${f}: a question has no text`);
  grants.push(g);
}
writeFileSync(join(root, 'src', 'worker', 'seed.generated.json'), JSON.stringify(grants));
console.log(`Bundled ${grants.length} grants, ${grants.reduce((n, g) => n + g.questions.length, 0)} questions`);
