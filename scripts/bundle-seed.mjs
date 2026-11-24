// Bundles the verified grant files in data/grants/*.json into one JSON module the Worker imports.
// Along the way it turns the researchers' bracketed notes into structure the portal can use:
//   "[Shown only when: {country} = 'United States']"  ->  show_if { parent: "Country", op: "=", value: "United States" }
// so questions that do not apply are hidden instead of explained.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'data', 'grants');

// Our own prose never uses em or en dashes. Question wording copied from a funder's form is left exactly as it is.
const plain = (s) => (typeof s === 'string' ? s.replace(/\s*[—–]\s*/g, ', ').replace(/,\s*,/g, ',') : s);

function parseCondition(expr, keys) {
  const m = expr.trim().match(/^\{([^}]+)\}\s*(=|!=|contains|empty|notempty)\s*(.*)$/);
  if (!m) return null;
  const parent = keys[m[1]];
  if (!parent) return null;
  let value = m[3].trim().replace(/^'(.*)'$/, '$1');
  let op = m[2];
  if (op === '=' && value === 'true') { op = 'yes'; value = ''; }
  if (op === '=' && value === 'false') { op = 'empty'; value = ''; }
  return { parent, op, value };
}

const grants = [];
let conditional = 0;
for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const g = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  if (!g.id || !g.title) throw new Error(`${f}: missing id or title`);
  if (!Array.isArray(g.questions)) g.questions = [];
  const keys = g.field_keys ?? {};
  for (const q of g.questions) {
    if (typeof q.text !== 'string' || !q.text.trim()) throw new Error(`${f}: a question has no text`);
    const rule = (q.help ?? '').match(/\[Shown only when: ([^\]]+)\]/);
    if (rule) {
      const cond = parseCondition(rule[1], keys);
      if (cond) {
        q.show_if = cond;
        q.help = q.help.replace(rule[0], '').replace(/\n{2,}/g, '\n').trim();
        conditional += 1;
      }
    }
  }
  for (const k of ['deadline_note', 'amount', 'amount_detail', 'questions_note', 'funder']) g[k] = plain(g[k]);
  for (const k of Object.keys(g.summary ?? {})) g.summary[k] = plain(g.summary[k]);
  if (g.portal?.notes) g.portal.notes = plain(g.portal.notes);
  delete g.field_keys;
  grants.push(g);
}
writeFileSync(join(root, 'src', 'worker', 'seed.generated.json'), JSON.stringify(grants));
console.log(`Bundled ${grants.length} grants, ${grants.reduce((n, g) => n + g.questions.length, 0)} questions, ${conditional} with show/hide rules`);
