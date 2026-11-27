// Cadena cita → onboarding: la primera reserva encola la bienvenida con la checklist y pasa la conversación al agente de onboarding
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, scriptedLlm, text, toolUse, TUESDAY_10AM_MIAMI as NOW, demoBusiness } from './helpers.js';
import { handleInbound } from '../api/engine.js';
import { tick } from '../api/scheduler.js';

const PHONE = '+13055550400';

// App con un LLM al que se le van añadiendo pasos; book() reserva por SMS a través del agente de citas
async function setup(business) {
  const script = [];
  const app = await makeApp({ llm: scriptedLlm(script), ...(business ? { business } : {}) });
  const book = async (start_local, address = PHONE) => {
    script.push(toolUse('book_appointment', { service: 'Cleaning', start_local, customer_name: 'Ana López' }), text('Booked!'));
    const r = await handleInbound(app, { channel: 'sms', address, text: 'Can I book a cleaning?', now: NOW });
    assert.equal(r.reply.endsWith('Booked!'), true);
  };
  return { app, book };
}

const lastEvent = app => app.db.prepare(`SELECT * FROM events WHERE type = 'booking.created' ORDER BY id DESC LIMIT 1`).get();
const welcomes = app => app.db.prepare(`SELECT * FROM outbox WHERE kind = 'onboarding'`).all();
const conversation = app => app.db.prepare('SELECT * FROM conversations ORDER BY id DESC LIMIT 1').get();
// Cancela la cita para poder reservar otra (book_appointment solo admite una futura por contacto)
const cancelAll = app => app.db.prepare(`UPDATE bookings SET status = 'cancelled'`).run();

test('primera cita → bienvenida con la checklist enviada y conversación en onboarding', async () => {
  const { app, book } = await setup();
  await book('2026-11-25T09:00');
  assert.equal(conversation(app).current_pack, 'scheduler');
  await tick(app, NOW);

  assert.equal(lastEvent(app).status, 'done');
  const [w] = welcomes(app);
  assert.ok(w, 'hay bienvenida');
  assert.equal(w.status, 'simulated', 'SMS sin Twilio configurado: simulado');
  assert.match(w.body, /Sonrisa Dental/);
  assert.match(w.body, /Cleaning/);
  assert.match(w.body, /Wed, Nov 25, 9:00\sAM/);
  assert.doesNotMatch(w.body, /\{(business|service|when|steps)\}/, 'sin marcadores sin sustituir');

  const conv = conversation(app);
  assert.equal(conv.current_pack, 'onboarding');
  const msg = app.db.prepare(`SELECT * FROM messages WHERE conversation_id = ? AND pack = 'onboarding'`).get(conv.id);
  assert.ok(msg, 'el mensaje queda en la conversación con el pack onboarding');
  for (const step of demoBusiness().onboarding.steps) assert.ok(msg.body.includes(step.name), `incluye el paso ${step.name}`);
  assert.match(msg.body, /1\) Patient intake form — /);

  // Cada escritura deja rastro en activity
  const act = app.db.prepare(`SELECT entity_type, action, after FROM activity WHERE (entity_type = 'outbox' AND action = 'queue') OR (entity_type = 'conversation' AND action = 'route')`).all();
  assert.ok(act.some(a => a.entity_type === 'outbox' && JSON.parse(a.after).kind === 'onboarding'));
  assert.ok(act.some(a => a.entity_type === 'conversation' && JSON.parse(a.after).reason === 'booking_to_onboarding'));
});

test('segunda cita del mismo cliente: skipped y sin otra bienvenida', async () => {
  const { app, book } = await setup();
  await book('2026-11-25T09:00');
  await tick(app, NOW);
  cancelAll(app);
  await book('2026-11-25T11:00');
  const ev = lastEvent(app);
  assert.equal(JSON.parse(ev.payload).first_booking, false);
  await tick(app, NOW);
  assert.equal(lastEvent(app).status, 'skipped');
  assert.equal(welcomes(app).length, 1);
});

test('cadena apagada en business.yaml: skipped', async () => {
  const { app, book } = await setup({ ...demoBusiness(), chains: { booking_to_onboarding: { enabled: false } } });
  await book('2026-11-25T09:00');
  await tick(app, NOW);
  assert.equal(lastEvent(app).status, 'skipped');
  assert.equal(welcomes(app).length, 0);
  assert.equal(conversation(app).current_pack, 'scheduler');
});

test('only_new_customers: false → también en una cita que no es la primera, una sola vez', async () => {
  const { app, book } = await setup({ ...demoBusiness(), chains: { booking_to_onboarding: { only_new_customers: false } } });
  await book('2026-11-25T09:00');
  // Simula que la bienvenida no salió en la primera (su evento se da por saltado) para probar una cita no primera
  app.db.prepare(`UPDATE events SET status = 'skipped'`).run();
  cancelAll(app);
  await book('2026-11-25T11:00');
  assert.equal(JSON.parse(lastEvent(app).payload).first_booking, false);
  await tick(app, NOW);
  assert.equal(lastEvent(app).status, 'done');
  assert.equal(welcomes(app).length, 1);
  // Otra cita más: la bienvenida ya existe → skipped (idempotente)
  cancelAll(app);
  await book('2026-11-25T14:00');
  await tick(app, NOW);
  assert.equal(lastEvent(app).status, 'skipped');
  assert.equal(welcomes(app).length, 1);
});

test('negocio sin onboarding.steps: skipped', async () => {
  const { app, book } = await setup({ ...demoBusiness(), onboarding: { steps: [] } });
  await book('2026-11-25T09:00');
  await tick(app, NOW);
  assert.equal(lastEvent(app).status, 'skipped');
  assert.match(lastEvent(app).last_error, /onboarding\.steps/);
  assert.equal(welcomes(app).length, 0);
});

test('contacto dado de baja (STOP): skipped', async () => {
  const { app, book } = await setup();
  await book('2026-11-25T09:00');
  app.db.prepare('UPDATE contacts SET opted_out = 1').run();
  await tick(app, NOW);
  assert.equal(lastEvent(app).status, 'skipped');
  assert.equal(welcomes(app).length, 0);
});

test('plantilla propia del negocio y pasos como texto', async () => {
  const business = { ...demoBusiness(), onboarding: { steps: ['Bring your ID'], welcome_template: 'Hi from {business}! {service} on {when}. Before you come: {steps}' } };
  const { app, book } = await setup(business);
  await book('2026-11-25T09:00');
  await tick(app, NOW);
  assert.match(welcomes(app)[0].body, /^Hi from Sonrisa Dental Miami! Cleaning on Wed, Nov 25, 9:00\sAM\. Before you come: 1\) Bring your ID$/);
});
