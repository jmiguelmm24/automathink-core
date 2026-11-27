// Automathink Core — tareas programadas (cada minuto): recordatorios de cita, seguimiento de leads,
// envío de la bandeja de salida e informe semanal. tick() se puede llamar a mano en los tests con un "now" fijo.
import { now as nowIso, logActivity, upsertContactConversation, addMessage, getMeta, setMeta } from './db.js';
import { humanTime, zonedParts } from './time.js';
import { sendSms } from './channels/sms.js';
import { TIER_MODELS } from './orquestador.js';
import { computeReport, reportText } from './reports.js';
import { notify } from './notify.js';
import { dispatchEvents } from './events.js';

const enabled = (app, id) => Boolean(app.packs[id]);
// Pack con el que se guarda en la conversación cada tipo de mensaje de la bandeja de salida
const OUTBOX_PACK = { reminder: 'scheduler', onboarding: 'onboarding', followup: 'followup' };

export async function tick(app, now = new Date()) {
  const out = { events: 0, reminders: 0, touches: 0, sent: 0, report: false };
  // Primero las cadenas entre agentes: si una reacción programa un toque o un mensaje, sale en esta misma vuelta
  out.events = await dispatchEvents(app, now);
  if (enabled(app, 'scheduler')) out.reminders = queueReminders(app, now);
  if (enabled(app, 'followup')) out.touches = await queueFollowups(app, now);
  out.sent = await flushOutbox(app, now);
  if (enabled(app, 'reports')) out.report = await weeklyReport(app, now);
  return out;
}

function enqueue(db, { contact_id, body, kind, send_at }) {
  const { lastInsertRowid } = db.prepare('INSERT INTO outbox (contact_id, body, kind, send_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(contact_id, body, kind, send_at, nowIso());
  logActivity(db, { entity_type: 'outbox', entity_id: Number(lastInsertRowid), action: 'queue', after: { kind } });
}

// Recordatorio X horas antes de cada cita confirmada (business.booking.reminder_hours_before)
function queueReminders(app, now) {
  const { db, business } = app;
  const tz = business.business.timezone;
  const until = new Date(now.getTime() + business.booking.reminder_hours_before * 3600000).toISOString();
  const due = db.prepare(`SELECT b.*, c.opted_out FROM bookings b JOIN contacts c ON c.id = b.contact_id
                          WHERE b.status = 'confirmed' AND b.reminder_sent = 0 AND b.starts_at > ? AND b.starts_at <= ?`).all(now.toISOString(), until);
  for (const b of due) db.transaction(() => {
    db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?').run(b.id);
    if (b.opted_out) return;
    const tpl = business.booking.reminder_template
      || 'Hi! Reminder from {business}: your {service} is on {when}. Reply YES to confirm or tell me if you need to reschedule.';
    enqueue(db, { contact_id: b.contact_id, kind: 'reminder', send_at: now.toISOString(),
      body: tpl.replace('{business}', business.business.name).replace('{service}', b.service).replace('{when}', humanTime(new Date(b.starts_at), tz)) });
  })();
  return due.length;
}

// Seguimiento: toques en los días de business.followup.touches_days, contados desde que entró el lead
async function queueFollowups(app, now) {
  const { db, business } = app;
  const days = business.followup.touches_days;
  const leads = db.prepare(`SELECT l.*, c.name, c.address, c.channel, c.opted_out FROM leads l JOIN contacts c ON c.id = l.contact_id
                            WHERE l.status IN ('new','qualified','nurturing') AND l.next_touch_at IS NOT NULL AND l.next_touch_at <= ?
                              AND c.opted_out = 0 AND c.channel = 'sms'`).all(now.toISOString());
  let n = 0;
  for (const lead of leads) {
    if (lead.touches >= days.length) { db.prepare('UPDATE leads SET next_touch_at = NULL WHERE id = ?').run(lead.id); continue; }
    const body = await composeTouch(app, lead, lead.touches + 1);
    // Siguiente toque: el día que toca desde que entró el lead, pero nunca antes de 20 h (si el servidor estuvo
    // parado no se mandan varios toques seguidos)
    const next = lead.touches + 1 < days.length
      ? new Date(Math.max(new Date(lead.created_at).getTime() + days[lead.touches + 1] * 86400000, now.getTime() + 20 * 3600000)).toISOString()
      : null;
    db.transaction(() => {
      db.prepare(`UPDATE leads SET touches = touches + 1, next_touch_at = ?, status = 'nurturing', updated_at = ? WHERE id = ?`).run(next, nowIso(), lead.id);
      enqueue(db, { contact_id: lead.contact_id, body, kind: 'followup', send_at: now.toISOString() });
    })();
    n++;
  }
  return n;
}

// Escribe el toque con Haiku (sin herramientas). Con el motor de prueba usa una plantilla.
async function composeTouch(app, lead, n) {
  const b = app.business;
  const fallback = n === 1
    ? `Hi${lead.name ? ' ' + lead.name.split(' ')[0] : ''}! This is ${b.assistant.name} from ${b.business.name}. Thanks for your interest${lead.interest ? ' in ' + lead.interest : ''}. Want me to find you a time this week?`
    : `Hi again from ${b.business.name}! Still happy to help${lead.interest ? ' with ' + lead.interest : ''}. Just reply here and I'll take care of it.`;
  if (app.config.llmProvider !== 'anthropic') return fallback;
  try {
    const pack = app.packs.followup;
    const res = await app.llm.messages.create({
      model: TIER_MODELS.facil, max_tokens: 200,
      system: `${pack.prompt}\nBusiness: ${b.business.name} (${b.business.industry || ''}). You are ${b.assistant.name}, its AI assistant. Tone: ${b.assistant.tone}`,
      messages: [{ role: 'user', content: `Write follow-up SMS #${n} of ${b.followup.touches_days.length}. Lead name: ${lead.name || 'unknown'}. Interest: ${lead.interest || 'unknown'}. Notes: ${lead.notes || '-'}. Reply with ONLY the SMS text.` }],
    });
    app.db.prepare(`INSERT INTO agent_runs (pack, model, tier, input_tokens, output_tokens, status, created_at) VALUES ('followup', ?, 'facil', ?, ?, 'done', ?)`)
      .run(TIER_MODELS.facil, res.usage?.input_tokens || 0, res.usage?.output_tokens || 0, nowIso());
    return res.content.filter(c => c.type === 'text').map(c => c.text).join('').trim().slice(0, 480) || fallback;
  } catch { return fallback; }
}

// Envía lo que toca. SMS por Twilio; en el chat web el mensaje aparece en la conversación.
async function flushOutbox(app, now) {
  const { db, config } = app;
  const due = db.prepare(`SELECT o.*, c.channel, c.address, c.opted_out FROM outbox o JOIN contacts c ON c.id = o.contact_id
                          WHERE o.status = 'pending' AND o.send_at <= ? ORDER BY o.id LIMIT 50`).all(now.toISOString());
  let sent = 0;
  for (const m of due) {
    if (m.opted_out) { db.prepare(`UPDATE outbox SET status = 'cancelled' WHERE id = ?`).run(m.id); continue; }
    try {
      const r = m.channel === 'sms' ? await sendSms(config, m.address, m.body) : { simulated: true };
      db.transaction(() => {
        db.prepare(`UPDATE outbox SET status = ?, sent_at = ? WHERE id = ?`).run(r.simulated && m.channel === 'sms' ? 'simulated' : 'sent', nowIso(), m.id);
        const { conversation } = upsertContactConversation(db, { channel: m.channel, address: m.address });
        addMessage(db, { conversation_id: conversation.id, role: 'assistant', body: m.body, pack: OUTBOX_PACK[m.kind] || 'followup' });
      })();
      sent++;
    } catch (e) {
      db.prepare(`UPDATE outbox SET status = 'failed' WHERE id = ?`).run(m.id);
      app.log?.warn({ err: String(e) }, 'mensaje no enviado');
    }
  }
  return sent;
}

// Lunes 08:00 (hora del negocio): informe de la semana al dueño
async function weeklyReport(app, now) {
  const p = zonedParts(now, app.business.business.timezone);
  if (p.weekday !== 'mon' || p.hh < 8) return false;
  const key = `report:${p.y}-${p.m}-${p.d}`;
  if (getMeta(app.db, key)) return false;
  setMeta(app.db, key, true);
  const r = computeReport(app.db, app.business, { days: 7, now });
  await notify(app, { kind: 'report', title: 'Weekly report', body: reportText(r, app.business.business.name) });
  return true;
}

export function startScheduler(app) {
  const t = setInterval(() => tick(app).catch(e => app.log.error({ err: String(e) }, 'fallo del programador')), app.config.schedulerMs);
  t.unref();
  return () => clearInterval(t);
}
