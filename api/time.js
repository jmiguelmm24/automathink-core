// Automathink Core — fechas en la zona horaria del negocio, sin librerías (Intl de Node).
// Las citas se guardan en UTC; el horario y lo que ve el cliente van en la hora local del negocio.

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Partes de una fecha vista en una zona horaria
export function zonedParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, weekday: p.weekday.toLowerCase().slice(0, 3) };
}

// Hora local (de la zona tz) → instante UTC. Corrige el desfase dos veces para cambios de horario.
export function zonedToUtc(y, m, d, hh, mm, tz) {
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), tz);
    const asIfUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
    guess += Date.UTC(y, m - 1, d, hh, mm) - asIfUtc;
  }
  return new Date(guess);
}

// "2026-11-24T10:30" (hora local del negocio) → Date en UTC, o null si no se entiende
export function parseLocal(text, tz) {
  const m = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  return m ? zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz) : null;
}

// Date → "2026-11-24T10:30" en hora local (lo que ve el modelo)
export function toLocalIso(date, tz) {
  const p = zonedParts(date, tz);
  const z = n => String(n).padStart(2, '0');
  return `${p.y}-${z(p.m)}-${z(p.d)}T${z(p.hh)}:${z(p.mm)}`;
}

// Date → "Tue, Nov 24, 10:30 AM" para mensajes
export const humanTime = (date, tz, lang = 'en') =>
  new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);

export const weekdayKey = i => WEEKDAYS[i];

// "09:00-13:00" → [540, 780] (minutos desde medianoche)
export function parseRange(r) {
  const m = String(r).match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  return m ? [+m[1] * 60 + +m[2], +m[3] * 60 + +m[4]] : null;
}
