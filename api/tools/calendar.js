// Automathink Core — agenda: huecos libres según el horario del business.yaml y las citas ya guardadas.
// (Integración con Google Calendar: siguiente paso; la interfaz de estas funciones no cambia.)
import { zonedParts, zonedToUtc, parseRange, weekdayKey, toLocalIso, humanTime } from '../time.js';

export const findService = (business, name) => {
  const n = String(name || '').toLowerCase().trim();
  return business.services.find(s => s.name.toLowerCase() === n)
    || business.services.find(s => s.name.toLowerCase().includes(n) || n.includes(s.name.toLowerCase()))
    || null;
};

const overlaps = (db, start, end, exceptId = 0) => Boolean(db.prepare(
  `SELECT 1 FROM bookings WHERE status = 'confirmed' AND id != ? AND starts_at < ? AND ends_at > ? LIMIT 1`,
).get(exceptId, end.toISOString(), start.toISOString()));

// ¿Está dentro del horario de ese día?
function withinHours(business, start, durationMin) {
  const tz = business.business.timezone;
  const p = zonedParts(start, tz);
  const ranges = business.hours[p.weekday] || [];
  const s = p.hh * 60 + p.mm, e = s + durationMin;
  return ranges.map(parseRange).some(r => r && s >= r[0] && e <= r[1]);
}

// Huecos libres. Devuelve [{ local: '2026-11-24T10:00', label: 'Tue, Nov 24, 10:00 AM' }, …]
export function availableSlots(db, business, { service, from = null, days = null, limit = 8, now = new Date() } = {}) {
  const svc = findService(business, service) || business.services[0];
  if (!svc) return [];
  const tz = business.business.timezone;
  const { slot_step_min: step, horizon_days, min_notice_hours } = business.booking;
  const earliest = new Date(now.getTime() + min_notice_hours * 3600000);
  const start = from && from > earliest ? from : earliest;
  const out = [];
  const base = zonedParts(start, tz);
  const totalDays = Math.min(days || horizon_days, horizon_days);
  for (let i = 0; i < totalDays && out.length < limit; i++) {
    // Día i en la zona del negocio (mediodía UTC de ese día para no saltar fechas)
    const dayDate = new Date(Date.UTC(base.y, base.m - 1, base.d + i, 12));
    const key = weekdayKey(dayDate.getUTCDay());
    let perDay = 0;
    for (const r of (business.hours[key] || []).map(parseRange).filter(Boolean)) {
      for (let t = r[0]; t + svc.duration_min <= r[1] && out.length < limit && perDay < 3; t += step) {
        const s = zonedToUtc(dayDate.getUTCFullYear(), dayDate.getUTCMonth() + 1, dayDate.getUTCDate(), Math.floor(t / 60), t % 60, tz);
        if (s < start) continue;
        const e = new Date(s.getTime() + svc.duration_min * 60000);
        if (overlaps(db, s, e)) continue;
        out.push({ local: toLocalIso(s, tz), label: humanTime(s, tz) });
        perDay++;   // máximo 3 opciones por día: el cliente elige mejor con pocas opciones repartidas
      }
    }
  }
  return out;
}

// Comprueba que un hueco concreto es reservable. Devuelve { ok, error?, service, start, end }
export function checkSlot(db, business, { service, start, now = new Date(), exceptId = 0 }) {
  const svc = findService(business, service);
  if (!svc) return { ok: false, error: `unknown service. Valid: ${business.services.map(s => s.name).join(', ')}` };
  if (!start) return { ok: false, error: 'invalid date, use YYYY-MM-DDTHH:MM in business local time' };
  const end = new Date(start.getTime() + svc.duration_min * 60000);
  if (start < new Date(now.getTime() + business.booking.min_notice_hours * 3600000)) return { ok: false, error: 'too soon or in the past' };
  if (!withinHours(business, start, svc.duration_min)) return { ok: false, error: 'outside business hours' };
  if (overlaps(db, start, end, exceptId)) return { ok: false, error: 'slot already taken' };
  return { ok: true, service: svc, start, end };
}
