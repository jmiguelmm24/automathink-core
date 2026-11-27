// Automathink Core — informe de impacto ("horas devueltas"): lo que se le enseña al cliente cada semana/mes.
// Las horas ahorradas son una ESTIMACIÓN con los supuestos de business.yaml (kpis); se muestran como tal.
import { costUsd } from './orquestador.js';

export function computeReport(db, business, { days = 7, now = new Date() } = {}) {
  const since = new Date(now.getTime() - days * 86400000).toISOString();
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  const conversations = one(`SELECT COUNT(DISTINCT conversation_id) AS n FROM messages WHERE role = 'user' AND created_at >= ?`, since).n;
  const inbound = one(`SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND created_at >= ?`, since).n;
  const aiReplies = one(`SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND created_at >= ?`, since).n;
  const bookings = one(`SELECT COUNT(*) AS n FROM bookings WHERE created_at >= ?`, since).n;
  const newLeads = one(`SELECT COUNT(*) AS n FROM leads WHERE created_at >= ?`, since).n;
  const handoffs = one(`SELECT COUNT(*) AS n FROM activity WHERE entity_type = 'conversation' AND action = 'handoff' AND created_at >= ?`, since).n;
  const optOuts = one(`SELECT COUNT(*) AS n FROM activity WHERE action = 'opt_out' AND created_at >= ?`, since).n;
  const afterHours = countAfterHours(db, business, since);
  const runs = db.prepare(`SELECT model, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cache_read_tokens) AS cr, SUM(cache_write_tokens) AS cw, COUNT(*) AS n
                           FROM agent_runs WHERE created_at >= ? GROUP BY model`).all(since);
  const tokens = runs.reduce((s, r) => s + r.i + r.o, 0);
  // La parte leída de la caché cuesta mucho menos: se valora aparte (antes se cobraba como entrada normal)
  const aiCost = runs.reduce((s, r) => s + costUsd(r.model, r.i, r.o, r.cr, r.cw), 0);
  const k = business.kpis;
  const minutesSaved = conversations * k.minutes_saved_per_conversation + bookings * k.minutes_saved_per_booking;
  return {
    period_days: days, conversations, inbound_messages: inbound, ai_replies: aiReplies, after_hours_messages: afterHours,
    bookings, new_leads: newLeads, handoffs, opt_outs: optOuts,
    hours_saved_estimate: Math.round(minutesSaved / 6) / 10,
    value_saved_usd_estimate: Math.round((minutesSaved / 60) * k.hourly_cost_usd),
    ai_tokens: tokens, ai_cost_usd: Math.round(aiCost * 100) / 100,
    assumptions: `${k.minutes_saved_per_conversation} min per conversation, ${k.minutes_saved_per_booking} min per booking, $${k.hourly_cost_usd}/h`,
  };
}

// Mensajes que llegaron con el negocio cerrado: el argumento más fuerte de venta ("esto lo habrías perdido")
function countAfterHours(db, business, since) {
  const tz = business.business.timezone;
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let n = 0;
  for (const { created_at } of db.prepare(`SELECT created_at FROM messages WHERE role = 'user' AND created_at >= ?`).all(since)) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(created_at)).map(x => [x.type, x.value]));
    const mins = +p.hour * 60 + +p.minute;
    const ranges = (business.hours[p.weekday.toLowerCase().slice(0, 3)] || []).map(r => r.split('-').map(t => { const [h, m] = t.trim().split(':'); return +h * 60 + +m; }));
    if (!ranges.some(([a, b]) => mins >= a && mins < b)) n++;
  }
  return n;
}

export const reportText = (r, name) =>
  `${name} — last ${r.period_days} days: ${r.conversations} conversations (${r.after_hours_messages} msgs after hours), ` +
  `${r.bookings} bookings, ${r.new_leads} new leads, ${r.handoffs} passed to your team. ` +
  `≈${r.hours_saved_estimate} h saved (~$${r.value_saved_usd_estimate}). AI cost: $${r.ai_cost_usd}.`;
