// Comprueba la sintaxis de todos los .js del proyecto (sin build ni linter).
// Uso: npm run check
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SKIP = new Set(['node_modules', '.git', 'data', 'backups', 'blueprints']);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})('.');

let bad = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) { bad++; console.error(`✗ ${f}\n${r.stderr}`); }
}
console.log(`${files.length - bad}/${files.length} archivos OK`);
process.exit(bad ? 1 : 0);
