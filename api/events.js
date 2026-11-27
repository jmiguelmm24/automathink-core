// Automathink Core — EVENTOS entre agentes (packs): lo que hace uno dispara a otro dentro del mismo cliente.
//
//   escritura (cita, lead…) ─► emit() en la MISMA transacción ─► tabla events (pending)
//   tick() cada minuto ─► dispatchEvents() ─► pack activo que reacciona (pack.json → reacts_to) ─► reactions.js
//
// Cada cadena se activa sola si el cliente tiene los packs; business.yaml → chains.<id> la apaga o ajusta.
// v1: un suscriptor por tipo de evento. Los reintentos repiten el handler: debe ser idempotente.
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { now as nowIso, logActivity } from './db.js';
import { PACKS_DIR } from './packs.js';
import { notify } from './notify.js';

export const MAX_ATTEMPTS = 3;
const RETRY_MIN = 5;
const BATCH = 50;

// Registra un evento. Llamar SIEMPRE dentro de la transacción de la escritura que lo origina.
export function emit(db, type, { contact_id = null, payload = {}, run_after = null } = {}) {
  const { lastInsertRowid } = db.prepare('INSERT INTO events (type, contact_id, payload, run_after, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(type, contact_id, JSON.stringify(payload), run_after, nowIso());
  logActivity(db, { entity_type: 'event', entity_id: Number(lastInsertRowid), action: 'emit', after: { type } });
  return Number(lastInsertRowid);
}

// Packs ACTIVOS que reaccionan a un tipo de evento: [{ pack, handler, chain, defaults }]
export function subscribers(app, type) {
  return Object.values(app.packs)
    .filter(p => p.reacts_to?.[type])
    .map(p => ({ pack: p, ...p.reacts_to[type] }));
}

// Configuración de una cadena: valores por defecto del pack.json + business.yaml → chains.<id>
export function chainConfig(app, chainId, defaults = {}) {
  return { enabled: true, ...defaults, ...(app.business.chains?.[chainId] || {}) };
}

// ¿Está activa una cadena para este cliente? (pack activo que la declara + no apagada en business.yaml)
export function chainEnabled(app, chainId) {
  for (const p of Object.values(app.packs))
    for (const sub of Object.values(p.reacts_to || {}))
      if (sub.chain === chainId) return chainConfig(app, chainId, sub.defaults).enabled !== false;
  return false;
}

// Carga (una vez) packs/<id>/reactions.js de los packs activos. Los tests pueden poner app.reactions a mano.
async function loadReactions(app) {
  if (app.reactions) return app.reactions;
  const out = {};
  for (const id of Object.keys(app.packs)) {
    const f = join(PACKS_DIR, id, 'reactions.js');
    if (existsSync(f)) out[id] = await import(pathToFileURL(f).href);
  }
  app.reactions = out;
  return out;
}

function finish(db, ev, { status, note = null, run_after = null, attempts = ev.attempts }) {
  db.transaction(() => {
    if (status === 'pending') db.prepare('UPDATE events SET run_after = ?, attempts = ?, last_error = ? WHERE id = ?').run(run_after, attempts, note, ev.id);
    else db.prepare('UPDATE events SET status = ?, attempts = ?, last_error = ?, processed_at = ? WHERE id = ?').run(status, attempts, note, nowIso(), ev.id);
    logActivity(db, { entity_type: 'event', entity_id: ev.id, action: status === 'pending' ? 'reschedule' : status, after: { type: ev.type, note } });
  })();
}

// Reparte los eventos pendientes. Devuelve cuántos se procesaron (done/skipped/failed) en esta vuelta.
export async function dispatchEvents(app, now = new Date()) {
  const { db } = app;
  const due = db.prepare(`SELECT * FROM events WHERE status = 'pending' AND (run_after IS NULL OR run_after <= ?) ORDER BY id LIMIT ?`)
    .all(now.toISOString(), BATCH);
  if (!due.length) return 0;
  const reactions = await loadReactions(app);
  let processed = 0;
  for (const ev of due) {
    const event = { ...ev, payload: JSON.parse(ev.payload || '{}') };
    const subs = subscribers(app, ev.type).filter(s => chainConfig(app, s.chain, s.defaults).enabled !== false);
    const sub = subs[0];
    const fn = sub && reactions[sub.pack.id]?.[sub.handler];
    if (!fn) { finish(db, ev, { status: 'skipped', note: sub ? `falta el handler ${sub.handler}` : 'sin suscriptores' }); processed++; continue; }
    try {
      const r = (await fn({ app, now, config: chainConfig(app, sub.chain, sub.defaults) }, event)) || { status: 'done' };
      if (r.status === 'later') { finish(db, ev, { status: 'pending', run_after: r.run_after, note: r.note || null }); continue; }
      finish(db, ev, { status: r.status === 'skipped' ? 'skipped' : 'done', note: r.note || null });
      processed++;
    } catch (e) {
      const attempts = ev.attempts + 1;
      const note = String(e.message || e).slice(0, 300);
      app.log?.warn({ err: note, event: ev.type, id: ev.id }, 'fallo en una reacción');
      if (attempts >= MAX_ATTEMPTS) {
        finish(db, ev, { status: 'failed', attempts, note });
        await notify(app, { kind: 'error', title: 'An automation step failed', body: `${ev.type} (#${ev.id}): ${note}` });
        processed++;
      } else {
        finish(db, ev, { status: 'pending', attempts, note, run_after: new Date(now.getTime() + RETRY_MIN * attempts * 60000).toISOString() });
      }
    }
  }
  return processed;
}
