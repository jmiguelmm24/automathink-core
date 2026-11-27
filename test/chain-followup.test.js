// Cadenas del pack de seguimiento: cancelación → seguimiento (cancel_to_followup) y lead caliente (hot_lead)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, scriptedLlm, toolUse, text, demoBusiness, TUESDAY_10AM_MIAMI as NOW } from './helpers.js';
import { handleInbound } from '../api/engine.js';
import { tick } from '../api/scheduler.js';

const H = 3600000;
const PHONE = '+13055550700';
const at = ms => new Date(NOW.getTime() + ms);
const withChains = chains => ({ ...demoBusiness(), chains });
const eventOf = (app, type) => app.db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(type);
const leadOf = app => app.db.prepare('SELECT * FROM leads ORDER BY id LIMIT 1').get();
const followups = app => app.db.prepare(`SELECT COUNT(*) n FROM outbox WHERE kind = 'followup'`).get().n;
const hotNotices = app => app.db.prepare(`SELECT COUNT(*) n FROM notifications WHERE kind = 'hot_lead'`).get().n;

// ---------------------------------------------------------------- cancelación → seguimiento

// Reserva (miércoles 09:00) y cancela por la conversación; opcionalmente vuelve a reservar el viernes
async function bookAndCancel({ business, channel = 'sms', address = PHONE, rebook = false } = {}) {
  const script = [
    toolUse('book_appointment', { service: 'Cleaning', start_local: '2026-11-25T09:00', customer_name: 'Ana López' }), text('Booked!'),
    toolUse('reschedule_appointment', { cancel: true }), text('Cancelled.'),
  ];
  if (rebook) script.push(toolUse('book_appointment', { service: 'Cleaning', start_local: '2026-11-27T09:00', customer_name: 'Ana López' }), text('Booked again!'));
  const app = await makeApp({ llm: scriptedLlm(script), ...(business ? { business } : {}) });
  await handleInbound(app, { channel, address, text: 'Can I book a cleaning tomorrow 9am? Ana López', now: NOW });
  await handleInbound(app, { channel, address, text: 'Please cancel my appointment', now: NOW });
  if (rebook) await handleInbound(app, { channel, address, text: 'Actually book me Friday 9am', now: NOW });
  assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM bookings WHERE status = 'cancelled'`).get().n, 1, 'la cita quedó cancelada');
  return app;
}

test('cancelación → espera 24 h y el lead vuelve a nutrición con un toque', async () => {
  const app = await bookAndCancel();
  assert.equal(leadOf(app).status, 'booked');
  await tick(app, NOW);
  const ev = eventOf(app, 'booking.cancelled');
  assert.equal(ev.status, 'pending');
  assert.equal(ev.run_after, at(24 * H).toISOString());
  assert.equal(followups(app), 0, 'aún no hay toque');
  await tick(app, at(23 * H));
  assert.equal(eventOf(app, 'booking.cancelled').status, 'pending', 'antes del plazo no hace nada');

  const t = await tick(app, at(24 * H + 60000));
  assert.equal(eventOf(app, 'booking.cancelled').status, 'done');
  const lead = leadOf(app);
  assert.equal(lead.status, 'nurturing');
  assert.equal(lead.interest, 'Cleaning');
  assert.equal(lead.touches, 1, 'queueFollowups manda el primer toque en la misma vuelta');
  assert.equal(t.touches, 1);
  assert.equal(followups(app), 1);
  assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM activity WHERE entity_type = 'lead' AND action = 'reengage'`).get().n, 1);
  assert.equal((await tick(app, at(24 * H + 120000))).touches, 0, 'no repite');
});

test('cancelación: si ya volvió a reservar, no se le persigue', async () => {
  const app = await bookAndCancel({ rebook: true });
  await tick(app, NOW);
  await tick(app, at(24 * H + 60000));
  assert.equal(eventOf(app, 'booking.cancelled').status, 'skipped');
  assert.equal(leadOf(app).status, 'booked');
  assert.equal(followups(app), 0);
});

test('cancelación: un contacto dado de baja (STOP) no recibe nada', async () => {
  const app = await bookAndCancel();
  await tick(app, NOW);
  await handleInbound(app, { channel: 'sms', address: PHONE, text: 'STOP', now: NOW });
  await tick(app, at(24 * H + 60000));
  assert.equal(eventOf(app, 'booking.cancelled').status, 'skipped');
  assert.equal(followups(app), 0);
});

test('cancelación: un contacto del chat web no recibe SMS', async () => {
  const app = await bookAndCancel({ channel: 'web', address: 'sess_cancel001' });
  await tick(app, NOW);
  await tick(app, at(24 * H + 60000));
  assert.equal(eventOf(app, 'booking.cancelled').status, 'skipped');
  assert.equal(leadOf(app).status, 'booked');
  assert.equal(followups(app), 0);
});

test('cancelación: cadena apagada en business.yaml → skipped', async () => {
  const app = await bookAndCancel({ business: withChains({ cancel_to_followup: { enabled: false } }) });
  await tick(app, NOW);
  assert.equal(eventOf(app, 'booking.cancelled').status, 'skipped');
  await tick(app, at(24 * H + 60000));
  assert.equal(followups(app), 0);
});

test('cancelación: after_hours se ajusta por cliente', async () => {
  const app = await bookAndCancel({ business: withChains({ cancel_to_followup: { after_hours: 2 } }) });
  await tick(app, NOW);
  assert.equal(eventOf(app, 'booking.cancelled').run_after, at(2 * H).toISOString());
  await tick(app, at(2 * H));
  assert.equal(eventOf(app, 'booking.cancelled').status, 'done');
  assert.equal(leadOf(app).touches, 1);
});

// ---------------------------------------------------------------- lead caliente

async function intake({ score, consent = true, business, phone = '+13055550800' } = {}) {
  const app = await makeApp({ llm: scriptedLlm([toolUse('save_lead', { interest: 'Invisalign', notes: 'ready to start', score }), text('Lead saved.')]),
    ...(business ? { business } : {}) });
  const res = await app.inject({ method: 'POST', url: '/api/intake', headers: { 'x-intake-token': 'tok-test' },
    payload: { name: 'Laura M', phone, message: 'Invisalign info please', consent_sms: consent } });
  assert.equal(res.statusCode, 200);
  return { app, body: res.json() };
}

test('lead caliente (9): sin toque al entrar, toque y un solo aviso en el primer tick', async () => {
  const { app, body } = await intake({ score: 9 });
  assert.equal(body.first_touch, true);
  assert.equal(leadOf(app).next_touch_at, null, 'lo programa la reacción, no el formulario');
  assert.equal(hotNotices(app), 1);
  const t = await tick(app, NOW);
  assert.equal(t.touches, 1);
  assert.equal(leadOf(app).touches, 1);
  assert.equal(eventOf(app, 'lead.scored').status, 'done');
  assert.equal(hotNotices(app), 1, 'la reacción no repite el aviso');
  assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM activity WHERE entity_type = 'lead' AND action = 'schedule_touch'`).get().n, 1);
});

test('lead frío (4): nutrición lenta, el toque sale 24 h después', async () => {
  const { app, body } = await intake({ score: 4 });
  assert.equal(body.first_touch, true);
  assert.equal(hotNotices(app), 0);
  const t = await tick(app, NOW);
  assert.equal(t.touches, 0);
  assert.equal(leadOf(app).next_touch_at, at(24 * H).toISOString());
  assert.equal((await tick(app, at(24 * H))).touches, 1);
  assert.equal(leadOf(app).touches, 1);
});

test('lead sin consentimiento SMS: ni toque ni reacción', async () => {
  const { app, body } = await intake({ score: 9, consent: false });
  assert.equal(body.first_touch, false);
  await tick(app, NOW);
  assert.equal(eventOf(app, 'lead.scored').status, 'skipped');
  assert.equal(leadOf(app).next_touch_at, null);
  assert.equal(followups(app), 0);
});

test('cadena hot_lead apagada: el formulario programa el toque inmediato como antes', async () => {
  const { app, body } = await intake({ score: 4, business: withChains({ hot_lead: { enabled: false } }) });
  assert.equal(body.first_touch, true);
  assert.ok(leadOf(app).next_touch_at, 'toque programado por /api/intake');
  // /api/intake usa la hora real: se procesa con un "now" posterior al reloj
  const t = await tick(app, new Date(Date.now() + 60000));
  assert.equal(t.touches, 1);
  assert.equal(eventOf(app, 'lead.scored').status, 'skipped');
});

test('min_score por cliente (6): un 7 es caliente → toque inmediato y un aviso', async () => {
  const { app } = await intake({ score: 7, business: withChains({ hot_lead: { min_score: 6 } }) });
  assert.equal(hotNotices(app), 1, 'save_lead usa el umbral de la cadena');
  assert.equal((await tick(app, NOW)).touches, 1);
  assert.equal(hotNotices(app), 1);
});
