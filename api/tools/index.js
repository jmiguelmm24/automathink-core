// Automathink Core — herramientas que pueden usar los agentes (tool use de Claude).
// Cada pack declara en su pack.json qué herramientas tiene; el servidor solo ofrece esas.
// ctx = { app, contact, conversation, now }  ·  run() devuelve un objeto que se le pasa al modelo como resultado.
import { now as nowIso, logActivity, setMeta, getMeta } from '../db.js';
import { availableSlots, checkSlot } from './calendar.js';
import { parseLocal, humanTime, toLocalIso } from '../time.js';
import { notify } from '../notify.js';
import { emit, chainConfig } from '../events.js';

const str = (d) => ({ type: 'string', description: d });

// Crea o actualiza el lead del contacto (uno por contacto)
function upsertLead(db, contactId, patch, actor = 'agent') {
  const cur = db.prepare('SELECT * FROM leads WHERE contact_id = ?').get(contactId);
  const t = nowIso();
  if (!cur) {
    const { lastInsertRowid } = db.prepare(`INSERT INTO leads (contact_id, status, interest, notes, score, next_touch_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(contactId, patch.status || 'new', patch.interest ?? null, patch.notes ?? null, patch.score ?? null, patch.next_touch_at ?? null, t, t);
    logActivity(db, { entity_type: 'lead', entity_id: Number(lastInsertRowid), action: 'create', after: patch, actor });
    return db.prepare('SELECT * FROM leads WHERE id = ?').get(lastInsertRowid);
  }
  const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined && v !== null)) };
  // Un lead ya agendado o ganado no "baja" de estado por una cualificación posterior
  if (['booked', 'won'].includes(cur.status) && ['new', 'qualified', 'nurturing'].includes(patch.status)) next.status = cur.status;
  db.prepare('UPDATE leads SET status = ?, interest = ?, notes = ?, score = ?, next_touch_at = ?, updated_at = ? WHERE id = ?')
    .run(next.status, next.interest, next.notes, next.score, next.next_touch_at, t, cur.id);
  logActivity(db, { entity_type: 'lead', entity_id: cur.id, action: 'update', before: { status: cur.status }, after: patch, actor });
  return { ...next };
}
export { upsertLead };

export const TOOLS = {
  check_availability: {
    description: 'Get free appointment slots. Always call this before offering times. Times are in the business local timezone.',
    input_schema: { type: 'object', properties: {
      service: str('Service name exactly as listed in the business profile'),
      from_date: str('Optional first day to look, YYYY-MM-DD (local). Use it when the customer asks for a specific day.'),
    }, required: ['service'] },
    run({ app, now }, { service, from_date }) {
      const tz = app.business.business.timezone;
      const from = from_date ? parseLocal(`${from_date}T00:00`, tz) : null;
      const slots = availableSlots(app.db, app.business, { service, from, now });
      return slots.length ? { timezone: tz, slots } : { slots: [], note: 'No free slots in the booking horizon. Offer to take their details so the team calls back.' };
    },
  },

  book_appointment: {
    description: 'Book a confirmed appointment. Only after the customer explicitly chose one of the slots returned by check_availability and gave their name.',
    input_schema: { type: 'object', properties: {
      service: str('Service name'), start_local: str('Chosen start, YYYY-MM-DDTHH:MM in business local time'),
      customer_name: str('Customer full name'), email: str('Optional email'), notes: str('Optional short notes for the team'),
    }, required: ['service', 'start_local', 'customer_name'] },
    async run(ctx, input) {
      const { app, contact, now } = ctx;
      const { db, business } = app;
      const tz = business.business.timezone;
      // Una cita futura por contacto: si ya tiene una, hay que usar reschedule_appointment
      const existing = db.prepare(`SELECT * FROM bookings WHERE contact_id = ? AND status = 'confirmed' AND starts_at > ?`).get(contact.id, now.toISOString());
      if (existing) return { ok: false, error: `customer already has a booking on ${toLocalIso(new Date(existing.starts_at), tz)}; use reschedule_appointment` };
      const chk = checkSlot(db, business, { service: input.service, start: parseLocal(input.start_local, tz), now });
      if (!chk.ok) return { ok: false, error: chk.error };
      const id = db.transaction(() => {
        db.prepare('UPDATE contacts SET name = ?, email = COALESCE(?, email) WHERE id = ?').run(input.customer_name, input.email || null, contact.id);
        const firstBooking = !db.prepare('SELECT 1 FROM bookings WHERE contact_id = ? LIMIT 1').get(contact.id);
        const { lastInsertRowid } = db.prepare('INSERT INTO bookings (contact_id, service, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(contact.id, chk.service.name, chk.start.toISOString(), chk.end.toISOString(), nowIso());
        logActivity(db, { entity_type: 'booking', entity_id: Number(lastInsertRowid), action: 'create', after: { service: chk.service.name, starts_at: chk.start.toISOString() } });
        upsertLead(db, contact.id, { status: 'booked', interest: chk.service.name, notes: input.notes });
        emit(db, 'booking.created', { contact_id: contact.id, payload: {
          booking_id: Number(lastInsertRowid), service: chk.service.name, starts_at: chk.start.toISOString(), first_booking: firstBooking } });
        return Number(lastInsertRowid);
      })();
      const when = humanTime(chk.start, tz);
      await notify(app, { kind: 'booking', title: `New booking: ${chk.service.name} · ${when}`, body: `${input.customer_name} (${contact.address})${input.notes ? ' — ' + input.notes : ''}` });
      return { ok: true, booking_id: id, service: chk.service.name, when, duration_min: chk.service.duration_min };
    },
  },

  reschedule_appointment: {
    description: 'Move or cancel the customer\'s next appointment. To cancel, set cancel=true. To move, give new_start_local (check availability first).',
    input_schema: { type: 'object', properties: {
      new_start_local: str('New start YYYY-MM-DDTHH:MM local'), cancel: { type: 'boolean' },
    } },
    async run({ app, contact, now }, { new_start_local, cancel }) {
      const { db, business } = app;
      const tz = business.business.timezone;
      const b = db.prepare(`SELECT * FROM bookings WHERE contact_id = ? AND status = 'confirmed' AND starts_at > ? ORDER BY starts_at LIMIT 1`).get(contact.id, now.toISOString());
      if (!b) return { ok: false, error: 'customer has no upcoming booking' };
      if (cancel) {
        db.transaction(() => {
          db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = ?`).run(b.id);
          logActivity(db, { entity_type: 'booking', entity_id: b.id, action: 'cancel' });
          emit(db, 'booking.cancelled', { contact_id: contact.id, payload: { booking_id: b.id, service: b.service, starts_at: b.starts_at } });
        })();
        await notify(app, { kind: 'booking', title: `Cancelled: ${b.service} · ${humanTime(new Date(b.starts_at), tz)}`, body: contact.address });
        return { ok: true, cancelled: true };
      }
      const chk = checkSlot(db, business, { service: b.service, start: parseLocal(new_start_local, tz), now, exceptId: b.id });
      if (!chk.ok) return { ok: false, error: chk.error };
      db.transaction(() => {
        db.prepare('UPDATE bookings SET starts_at = ?, ends_at = ?, reminder_sent = 0 WHERE id = ?').run(chk.start.toISOString(), chk.end.toISOString(), b.id);
        logActivity(db, { entity_type: 'booking', entity_id: b.id, action: 'reschedule', before: { starts_at: b.starts_at }, after: { starts_at: chk.start.toISOString() } });
      })();
      const when = humanTime(chk.start, tz);
      await notify(app, { kind: 'booking', title: `Rescheduled: ${b.service} → ${when}`, body: contact.address });
      return { ok: true, when };
    },
  },

  save_lead: {
    description: 'Save what you learned about this person as a lead (interest, qualification notes, 1-10 score of how ready they are to buy).',
    input_schema: { type: 'object', properties: {
      name: str('Name if known'), email: str('Email if given'), interest: str('What they want'),
      notes: str('Key qualification facts (budget, timing, need)'), score: { type: 'integer', minimum: 1, maximum: 10 },
    }, required: ['interest'] },
    async run({ app, contact }, input) {
      const { db } = app;
      const lead = db.transaction(() => {
        if (input.name || input.email) db.prepare('UPDATE contacts SET name = COALESCE(?, name), email = COALESCE(?, email) WHERE id = ?').run(input.name || null, input.email || null, contact.id);
        return upsertLead(db, contact.id, { status: 'qualified', interest: input.interest, notes: input.notes, score: input.score });
      })();
      // Aviso de la cadena "lead caliente": umbral configurable por cliente (business.yaml → chains.hot_lead.min_score)
      const minScore = app.packs.followup ? chainConfig(app, 'hot_lead', { min_score: 8 }).min_score : 8;
      if ((input.score || 0) >= minScore) await notify(app, { kind: 'hot_lead', title: `Hot lead (${input.score}/10): ${input.interest}`, body: `${input.name || contact.address} — ${input.notes || ''}` });
      return { ok: true, lead_id: lead.id, status: lead.status };
    },
  },

  handoff_to_human: {
    description: 'Pass the conversation to a person on the team. Use for emergencies, complaints, legal/medical questions, or when the customer asks for a human.',
    input_schema: { type: 'object', properties: { reason: str('Why') }, required: ['reason'] },
    async run({ app, contact, conversation }, { reason }) {
      app.db.transaction(() => {
        app.db.prepare(`UPDATE conversations SET status = 'handoff' WHERE id = ?`).run(conversation.id);
        logActivity(app.db, { entity_type: 'conversation', entity_id: conversation.id, action: 'handoff', after: { reason } });
      })();
      await notify(app, { kind: 'handoff', title: 'A customer needs a person', body: `${contact.name || contact.address}: ${reason}` });
      return { ok: true, note: 'Tell the customer a team member will reach out shortly. Do not keep answering after this.' };
    },
  },

  update_onboarding: {
    description: 'Record an onboarding step for this customer (e.g. documents received, form completed, account created).',
    input_schema: { type: 'object', properties: { step: str('Step name from the onboarding checklist'), value: str('What was provided / status') }, required: ['step', 'value'] },
    async run({ app, contact }, { step, value }) {
      const key = `onboarding:${contact.id}`;
      const state = getMeta(app.db, key, {});
      state[step] = { value, at: nowIso() };
      app.db.transaction(() => {
        setMeta(app.db, key, state);
        logActivity(app.db, { entity_type: 'contact', entity_id: contact.id, action: 'onboarding_step', after: { step } });
      })();
      const steps = app.business.onboarding.steps.map(s => s.name || s);
      const missing = steps.filter(s => !state[s]);
      if (steps.length && !missing.length) await notify(app, { kind: 'onboarding', title: 'Onboarding complete', body: contact.name || contact.address });
      return { ok: true, completed: Object.keys(state), missing };
    },
  },
};

// Definiciones para la API de Claude (solo las del pack)
export const toolDefs = names => names.filter(n => TOOLS[n]).map(n => ({ name: n, description: TOOLS[n].description, input_schema: TOOLS[n].input_schema }));
