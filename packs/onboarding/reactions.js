// Pack onboarding — reacciones a eventos de otros agentes (ver api/events.js).
// Cadena booking_to_onboarding: al reservar su primera cita, el cliente recibe la bienvenida con la checklist
// y su conversación pasa al agente de onboarding.
import { now as nowIso, logActivity } from '../../api/db.js';
import { humanTime } from '../../api/time.js';

const DEFAULT_TEMPLATE = 'Welcome to {business}! Your {service} is booked for {when}. '
  + 'To get you ready before your visit, here is what we need:\n{steps}\n'
  + 'Reply here if you have any questions or once you have completed a step.';

// Pasos del business.yaml (texto o { name, how }) → "1) Nombre — cómo"
function stepsText(steps) {
  return steps.map((s, i) => {
    const name = typeof s === 'string' ? s : s.name;
    const how = typeof s === 'string' ? '' : s.how;
    return `${i + 1}) ${name}${how ? ` — ${how}` : ''}`;
  }).join('\n');
}

function welcomeBody(business, payload) {
  const tpl = business.onboarding.welcome_template || DEFAULT_TEMPLATE;
  const values = {
    business: business.business.name,
    service: payload.service || 'appointment',
    when: payload.starts_at ? humanTime(new Date(payload.starts_at), business.business.timezone) : 'your scheduled time',
    steps: stepsText(business.onboarding.steps),
  };
  return tpl.replace(/\{(business|service|when|steps)\}/g, (_, k) => values[k]);
}

export async function onBookingCreated(ctx, event) {
  const { app, now, config } = ctx;
  const { db, business } = app;
  const payload = event.payload || {};
  if (config.only_new_customers && !payload.first_booking) return { status: 'skipped', note: 'no es la primera cita' };
  if (!business.onboarding?.steps?.length) return { status: 'skipped', note: 'el negocio no tiene onboarding.steps' };
  const contact = event.contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(event.contact_id) : null;
  if (!contact) return { status: 'skipped', note: 'contacto no encontrado' };
  if (contact.opted_out) return { status: 'skipped', note: 'contacto dado de baja (STOP)' };
  // Idempotente: los reintentos no deben mandar una segunda bienvenida
  if (db.prepare(`SELECT 1 FROM outbox WHERE contact_id = ? AND kind = 'onboarding' LIMIT 1`).get(contact.id))
    return { status: 'skipped', note: 'bienvenida ya encolada' };

  const body = welcomeBody(business, payload);
  db.transaction(() => {
    const { lastInsertRowid } = db.prepare('INSERT INTO outbox (contact_id, body, kind, send_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(contact.id, body, 'onboarding', now.toISOString(), nowIso());
    logActivity(db, { entity_type: 'outbox', entity_id: Number(lastInsertRowid), action: 'queue', after: { kind: 'onboarding' } });
    // Sus respuestas las atiende el agente de onboarding
    const conv = db.prepare(`SELECT id, current_pack FROM conversations WHERE contact_id = ? ORDER BY (status != 'closed') DESC, id DESC LIMIT 1`).get(contact.id);
    if (conv) {
      db.prepare('UPDATE conversations SET current_pack = ?, updated_at = ? WHERE id = ?').run('onboarding', nowIso(), conv.id);
      logActivity(db, { entity_type: 'conversation', entity_id: conv.id, action: 'route',
        before: { pack: conv.current_pack }, after: { pack: 'onboarding', reason: 'booking_to_onboarding' } });
    }
  })();
  return { status: 'done', note: 'bienvenida de onboarding encolada' };
}
