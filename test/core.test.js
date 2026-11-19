import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, scriptedLlm, text, toolUse, login, TUESDAY_10AM_MIAMI as NOW, demoBusiness } from './helpers.js';
import { zonedToUtc, toLocalIso, parseLocal } from '../api/time.js';
import { availableSlots, checkSlot } from '../api/tools/calendar.js';
import { handleInbound } from '../api/engine.js';
import { route, chooseModel } from '../api/orquestador.js';
import { tick } from '../api/scheduler.js';
import { computeReport } from '../api/reports.js';
import { twilioSignature } from '../api/channels/sms.js';

test('hora local ↔ UTC con cambio de horario (Miami)', () => {
  assert.equal(zonedToUtc(2026, 7, 1, 10, 0, 'America/New_York').toISOString(), '2026-07-01T14:00:00.000Z'); // EDT
  assert.equal(zonedToUtc(2026, 12, 1, 10, 0, 'America/New_York').toISOString(), '2026-12-01T15:00:00.000Z'); // EST
  assert.equal(toLocalIso(new Date('2026-11-24T15:00:00Z'), 'America/New_York'), '2026-11-24T10:00');
});

test('agenda: huecos dentro del horario, con antelación mínima y sin solapes', async () => {
  const app = await makeApp();
  const slots = availableSlots(app.db, app.business, { service: 'Cleaning', now: NOW });
  assert.ok(slots.length > 0);
  assert.ok(slots[0].local >= '2026-11-24T12:00', 'respeta las 2 h de antelación');
  // Los huecos de la mañana acaban a las 13:00: una limpieza de 45 min no puede empezar a las 12:30
  assert.ok(!slots.some(s => s.local.endsWith('T12:30')));
  const ok = checkSlot(app.db, app.business, { service: 'Cleaning', start: parseLocal('2026-11-25T09:00', 'America/New_York'), now: NOW });
  assert.equal(ok.ok, true);
  assert.equal(checkSlot(app.db, app.business, { service: 'Cleaning', start: parseLocal('2026-11-29T10:00', 'America/New_York'), now: NOW }).error, 'outside business hours'); // domingo
});

test('orquestador: STOP, pasar a humano, palabras clave y continuidad', async () => {
  const app = await makeApp();
  const conv = { status: 'open', current_pack: null };
  assert.equal((await route(app, { text: 'STOP', conversation: conv })).action, 'opt_out');
  assert.equal((await route(app, { text: 'I want to talk to a lawyer', conversation: conv })).action, 'handoff');
  assert.equal((await route(app, { text: 'Can I book a cleaning?', conversation: conv })).pack.id, 'scheduler');
  assert.equal((await route(app, { text: 'quiero una cita', conversation: conv })).pack.id, 'scheduler');
  assert.equal((await route(app, { text: 'Where do I park?', conversation: conv })).pack.id, 'reception');
  assert.equal((await route(app, { text: 'the second one', conversation: { status: 'open', current_pack: 'scheduler' } })).pack.id, 'scheduler');
  assert.equal((await route(app, { text: 'hola', conversation: { status: 'handoff' } })).action, 'ignore');
  assert.equal(chooseModel(app, { pack: app.packs.reception, text: 'I am very upset with my last visit' }).tier, 'normal');
});

test('conversación completa: pide cita → huecos → reserva → aviso al dueño', async () => {
  let offered;
  const llm = scriptedLlm([
    toolUse('check_availability', { service: 'Cleaning' }),
    req => { offered = JSON.parse(req.messages.at(-1).content[0].content).slots; return text(`I have ${offered[0].label}. Name?`); },
    toolUse('book_appointment', { service: 'Cleaning', start_local: '2026-11-25T09:00', customer_name: 'Ana López' }),
    text('Booked! See you Wednesday.'),
  ]);
  const app = await makeApp({ llm });
  const r1 = await handleInbound(app, { channel: 'sms', address: '+13055550100', text: 'Hi, can I book a cleaning?', now: NOW });
  assert.equal(r1.pack, 'scheduler');
  assert.match(r1.reply, /^Hi! I'm Ava, Sonrisa Dental's virtual assistant \(AI\)/, 'aviso de IA en la primera respuesta');
  assert.ok(offered.length > 0);
  const r2 = await handleInbound(app, { channel: 'sms', address: '+13055550100', text: 'Ana López, tomorrow 9am please', now: NOW });
  assert.equal(r2.reply, 'Booked! See you Wednesday.', 'sin repetir el aviso');
  const b = app.db.prepare('SELECT * FROM bookings').get();
  assert.equal(b.starts_at, '2026-11-25T14:00:00.000Z');
  assert.equal(app.db.prepare('SELECT status FROM leads').get().status, 'booked');
  assert.match(app.db.prepare(`SELECT title FROM notifications WHERE kind = 'booking'`).get().title, /New booking: Cleaning/);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM agent_runs').get().n, 2);
  // el agente solo recibe las herramientas de su pack
  assert.deepEqual(llm.calls[0].tools.map(t => t.name).sort(), [...app.packs.scheduler.tools].sort());
});

test('no se puede reservar un hueco ocupado ni una herramienta que no es del pack', async () => {
  const llm = scriptedLlm([
    toolUse('book_appointment', { service: 'Cleaning', start_local: '2026-11-25T09:00', customer_name: 'A' }), text('ok1'),
    toolUse('book_appointment', { service: 'Cleaning', start_local: '2026-11-25T09:00', customer_name: 'B' }),
    req => text(JSON.parse(req.messages.at(-1).content[0].content).error),
    toolUse('book_appointment', { service: 'Cleaning', start_local: '2026-11-25T11:00', customer_name: 'C' }),
    req => text(JSON.parse(req.messages.at(-1).content[0].content).error),
  ]);
  const app = await makeApp({ llm });
  await handleInbound(app, { channel: 'sms', address: '+13055550001', text: 'book please', now: NOW });
  const r = await handleInbound(app, { channel: 'sms', address: '+13055550002', text: 'book please', now: NOW });
  assert.match(r.reply, /slot already taken/);
  const r3 = await handleInbound(app, { channel: 'web', address: 'sess_abcdefgh', text: 'Where do I park?', now: NOW });
  assert.match(r3.reply, /not allowed/, 'reception no tiene book_appointment');
});

test('STOP da de baja, cancela lo pendiente y la IA deja de responder; START reactiva', async () => {
  const app = await makeApp({ llm: scriptedLlm([text('hello')]) });
  await handleInbound(app, { channel: 'sms', address: '+13055550200', text: 'hi', now: NOW });
  const c = app.db.prepare('SELECT id FROM contacts').get();
  app.db.prepare(`INSERT INTO outbox (contact_id, body, kind, send_at, created_at) VALUES (?, 'x', 'followup', ?, ?)`).run(c.id, NOW.toISOString(), NOW.toISOString());
  const r = await handleInbound(app, { channel: 'sms', address: '+13055550200', text: 'STOP', now: NOW });
  assert.match(r.reply, /unsubscribed/);
  assert.equal(app.db.prepare('SELECT opted_out FROM contacts').get().opted_out, 1);
  assert.equal(app.db.prepare('SELECT status FROM outbox').get().status, 'cancelled');
  assert.equal((await handleInbound(app, { channel: 'sms', address: '+13055550200', text: 'hello?', now: NOW })).reply, null);
  assert.match((await handleInbound(app, { channel: 'sms', address: '+13055550200', text: 'START', now: NOW })).reply, /subscribed again/);
});

test('pasar a humano: aviso al dueño y la IA se calla hasta que el panel la reactive', async () => {
  const app = await makeApp();
  const r = await handleInbound(app, { channel: 'sms', address: '+13055550300', text: 'I have swelling and bleeding', now: NOW });
  assert.match(r.reply, /call 911/);
  assert.equal(app.db.prepare('SELECT status FROM conversations').get().status, 'handoff');
  assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM notifications WHERE kind = 'handoff'`).get().n, 1);
  assert.equal((await handleInbound(app, { channel: 'sms', address: '+13055550300', text: 'hello?', now: NOW })).reply, null);
});

test('programador: recordatorio 24 h antes y seguimiento tras un formulario (speed to lead)', async () => {
  const app = await makeApp({ llm: scriptedLlm([toolUse('save_lead', { interest: 'Invisalign', notes: 'wants it before wedding in March', score: 8 }), text('Hot Invisalign lead.')]) });
  // Formulario → back-office
  const res = await app.inject({ method: 'POST', url: '/api/intake', headers: { 'x-intake-token': 'tok-test' },
    payload: { name: 'Laura M', phone: '+13055550400', message: 'Invisalign info please', consent_sms: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().first_touch, true);
  assert.equal(app.db.prepare('SELECT score FROM leads').get().score, 8);
  assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM notifications WHERE kind = 'hot_lead'`).get().n, 1);
  // Cita mañana a las 09:00 → recordatorio
  const c = app.db.prepare('SELECT id FROM contacts').get();
  app.db.prepare(`INSERT INTO bookings (contact_id, service, starts_at, ends_at, created_at) VALUES (?, 'Cleaning', '2026-11-25T14:00:00.000Z', '2026-11-25T14:45:00.000Z', ?)`).run(c.id, NOW.toISOString());
  const t = await tick(app, NOW);
  assert.equal(t.reminders, 1);
  assert.equal(t.touches, 1);
  assert.equal(t.sent, 2);
  assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM outbox WHERE status = 'simulated'`).get().n, 2, 'sin Twilio se simula');
  const lead = app.db.prepare('SELECT touches, next_touch_at FROM leads').get();
  assert.equal(lead.touches, 1);
  assert.ok(lead.next_touch_at > NOW.toISOString());
  assert.deepEqual(await tick(app, NOW), { reminders: 0, touches: 0, sent: 0, report: false }, 'no repite');
  // Sin consentimiento SMS no hay toque
  const r2 = await app.inject({ method: 'POST', url: '/api/intake', headers: { 'x-intake-token': 'tok-test' }, payload: { phone: '+13055550401', message: 'hi' } });
  assert.equal(r2.json().first_touch, false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/intake', headers: { 'x-intake-token': 'mal' }, payload: { phone: '+13055550401' } })).statusCode, 401);
});

test('informe: horas ahorradas y fuera de horario', async () => {
  const app = await makeApp({ llm: scriptedLlm([text('a'), text('b')]) });
  await handleInbound(app, { channel: 'web', address: 'sess_report01', text: 'hours?', now: NOW });
  const night = new Date('2026-11-25T03:00:00Z'); // 22:00 en Miami
  app.db.prepare(`INSERT INTO messages (conversation_id, role, body, created_at) VALUES (1, 'user', 'late', ?)`).run(night.toISOString());
  const r = computeReport(app.db, app.business, { days: 7, now: new Date('2026-11-26T00:00:00Z') });
  assert.equal(r.conversations, 1);
  assert.equal(r.after_hours_messages, 1);
  assert.equal(r.hours_saved_estimate, 0.1);
});

test('API: panel protegido, chat público, firma de Twilio', async () => {
  const app = await makeApp({ llm: scriptedLlm([text('Free parking behind the building.')]) , env: { TWILIO_SKIP_SIGNATURE: 'false', TWILIO_AUTH_TOKEN: 'tw-secret', PUBLIC_BASE_URL: 'https://demo.example.com' } });
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  assert.equal((await app.inject('/api/conversations')).statusCode, 401);
  const chat = await app.inject({ method: 'POST', url: '/api/public/chat', payload: { session_id: 'sess_12345678', message: 'Where do I park?' } });
  assert.equal(chat.statusCode, 200);
  assert.match(chat.json().reply, /parking/);
  const cookie = await login(app);
  const list = await app.inject({ url: '/api/conversations', headers: { cookie } });
  assert.equal(list.json().length, 1);
  // Twilio: firma mala → 403; buena → 200 TwiML
  const params = { From: '+13055550500', Body: 'STOP' };
  assert.equal((await app.inject({ method: 'POST', url: '/webhooks/twilio/sms', payload: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'bad' } })).statusCode, 403);
  const sig = twilioSignature('tw-secret', 'https://demo.example.com/webhooks/twilio/sms', params);
  const ok = await app.inject({ method: 'POST', url: '/webhooks/twilio/sms', payload: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig } });
  assert.equal(ok.statusCode, 200);
  assert.match(ok.body, /<Response>/);
});

test('el template de cliente carga y un pack inexistente da error claro', async () => {
  const b = demoBusiness();
  b.packs = ['reception', 'no-existe'];
  await assert.rejects(makeApp({ business: b }), /no existen: no-existe/);
});
