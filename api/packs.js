// Automathink Core — carga de packs (cada pack = un agente ejecutor vendible).
// packs/<id>/pack.json  → nombre comercial, tipo, herramientas, palabras clave de enrutado, nivel de modelo
// packs/<id>/prompt.md  → instrucciones del agente (se combinan con el perfil del negocio)
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'packs');

export function loadPacks(enabled, dir = PACKS_DIR) {
  const all = {};
  for (const id of readdirSync(dir)) {
    const f = join(dir, id, 'pack.json');
    if (!existsSync(f)) continue;
    const pack = JSON.parse(readFileSync(f, 'utf8'));
    const promptFile = join(dir, id, 'prompt.md');
    pack.prompt = existsSync(promptFile) ? readFileSync(promptFile, 'utf8') : '';
    pack.keywordRe = pack.route?.keywords?.length ? new RegExp(pack.route.keywords.join('|'), 'i') : null;
    all[id] = pack;
  }
  const unknown = enabled.filter(id => !all[id]);
  if (unknown.length) throw new Error(`business.yaml activa packs que no existen: ${unknown.join(', ')}. Disponibles: ${Object.keys(all).join(', ')}`);
  return Object.fromEntries(enabled.map(id => [id, all[id]]));
}
