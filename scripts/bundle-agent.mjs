// Packs the VM runner files so the portal can serve them (install + self-update), stamped with a content hash.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const names = ['runner.mjs', 'grantctl', 'SKILL.md', 'package.json', 'liveview.sh', 'install.sh'];
const files = Object.fromEntries(names.map((n) => [n, readFileSync(join(root, 'agent', n), 'utf8')]));
const hash = createHash('sha256').update(names.map((n) => files[n]).join('\0')).digest('hex').slice(0, 10);
const base = files['runner.mjs'].match(/export const VERSION = '([^']+)'/)?.[1];
if (!base) throw new Error('runner.mjs has no VERSION');
const version = `${base}+${hash}`;
files['runner.mjs'] = files['runner.mjs'].replace(/export const VERSION = '[^']+'/, `export const VERSION = '${version}'`);
writeFileSync(join(root, 'src', 'worker', 'agent.generated.json'), JSON.stringify({ version, files }));
console.log(`Packed agent ${version}`);
