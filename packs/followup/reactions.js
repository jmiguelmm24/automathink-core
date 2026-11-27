// Reacciones del pack de seguimiento a eventos de otros agentes (ver api/events.js y pack.json → reacts_to).
// Cada handler recibe ctx = { app, now, config } y el evento; devuelve { status, note } o { status: 'later', run_after }.
// Solo programan el toque (next_touch_at): lo escribe y lo envía queueFollowups en el mismo tick (api/scheduler.js).
// Deben ser idempotentes: un reintento repite el handler.
import { logActivity } from '../../api/db.js';

const HOUR_MS = 3600000;
const ACTIVE = ['new', 'qualified', 'nurturing'];

const contactOf = (db, id) => db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);

// Cadena "cancelación → seguimiento" (cancel_to_followup): espera after_hours y vuelve a nutrir al lead por SMS
export async function onBookingCancelled({ app, now, config }, event) {
  // Primera vez: se aplaza el plazo configurado (contado desde que se procesa, con el "now" del tick)
  if (!event.run_after) return { status: 'later', run_after: new Date(now.getTime() + Number(config.after_hours) * HOUR_MS).toISOString() };
  const { db } = app;
  const contact = contactOf(db, event.contact_id);
  if (!contact) return { status: 'skipped', note: 'contacto inexistente' };
  // TCPA: STOP lo corta todo y solo se escribe por SMS a quien ya conversaba con el negocio por SMS
  if (contact.opted_out) return { status: 'skipped', note: 'contacto dado de baja' };
  if (contact.channel !== 'sms') return { status: 'skipped', note: 'contacto sin SMS' };
  const rebooked = db.prepare(`SELECT 1 FROM bookings WHERE contact_id = ? AND status = 'confirmed' AND starts_at > ? LIMIT 1`).get(contact.id, now.toISOString());
  if (rebooked) return { status: 'skipped', note: 'ya tiene otra cita' };
  const service = event.payload.service || null;
  const t = now.toISOString();
  db.transaction(() => {
    const cur = db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(contact.id);
    let leadId = cur?.id;
    // Se actualiza a mano: upsertLead no deja pasar un lead "booked" a "nurturing" a propósito
    if (cur) {
      db.prepare(`UPDATE leads SET status = 'nurturing', interest = ?, touches = 0, next_touch_at = ?, updated_at = ? WHERE id = ?`)
        .run(service ?? cur.interest, t, t, cur.id);
    } else {
      const { lastInsertRowid } = db.prepare(`INSERT INTO leads (contact_id, status, interest, touches, next_touch_at, created_at, updated_at)
        VALUES (?, 'nurturing', ?, 0, ?, ?, ?)`).run(contact.id, service, t, t, t);
      leadId = Number(lastInsertRowid);
    }
    logActivity(db, { entity_type: 'lead', entity_id: leadId, action: 'reengage',
      before: cur ? { status: cur.status, touches: cur.touches } : null, after: { reason: 'cancel_to_followup', service } });
  })();
  return { status: 'done', note: 'lead en nutrición' };
}

// Cadena "lead caliente" (hot_lead): decide cuándo sale el primer toque de un lead de formulario según su puntuación.
// El aviso al dueño lo manda save_lead (api/tools/index.js) con el mismo min_score: aquí no se avisa otra vez.
export async function onLeadScored({ app, now, config }, event) {
  const p = event.payload || {};
  // TCPA: solo formularios con consentimiento SMS y teléfono válido
  if (p.source !== 'intake' || !p.consent_sms || !p.phone_ok) return { status: 'skipped', note: 'sin consentimiento SMS o no es de formulario' };
  const { db } = app;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(p.lead_id);
  if (!lead) return { status: 'skipped', note: 'lead inexistente' };
  const contact = contactOf(db, lead.contact_id);
  if (!contact || contact.opted_out) return { status: 'skipped', note: 'contacto dado de baja' };
  // No se pisa una secuencia en marcha ni un lead ya agendado/ganado/perdido
  if (lead.touches !== 0 || !ACTIVE.includes(lead.status)) return { status: 'skipped', note: 'secuencia en marcha o lead cerrado' };
  const score = p.score ?? null;
  const hot = score !== null && score >= Number(config.min_score);
  const next = hot ? now : new Date(now.getTime() + Number(config.low_score_delay_hours) * HOUR_MS);
  db.transaction(() => {
    db.prepare('UPDATE leads SET next_touch_at = ?, updated_at = ? WHERE id = ?').run(next.toISOString(), now.toISOString(), lead.id);
    logActivity(db, { entity_type: 'lead', entity_id: lead.id, action: 'schedule_touch',
      before: { next_touch_at: lead.next_touch_at }, after: { reason: 'hot_lead', score, next_touch_at: next.toISOString() } });
  })();
  return { status: 'done', note: hot ? 'toque inmediato' : 'nutrición lenta' };
}
