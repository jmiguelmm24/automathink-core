import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, scriptedLlm, toolUse, TUESDAY_10AM_MIAMI as NOW } from './helpers.js';
import { handleInbound, runAgent, RefusalError } from '../api/engine.js';

// Respuesta de rechazo de los clasificadores de seguridad (HTTP 200, sin texto)
const refusal = (category = 'cyber') => ({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category, explanation: 'x' } });

function assertHandedOff(app, r) {
  assert.ok(r.reply.endsWith(app.business.handoff.message), 'responde con el mensaje de traspaso');
  assert.doesNotMatch(r.reply, /Got it!/);
  assert.equal(r.route.action, 'handoff');
  assert.equal(app.db.prepare('SELECT status FROM conversations').get().status, 'handoff');
  assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM activity WHERE entity_type = 'conversation' AND action = 'handoff'`).get().n, 1);
  const n = app.db.prepare(`SELECT title FROM notifications WHERE kind = 'handoff'`).all();
  assert.equal(n.length, 1);
  assert.equal(n[0].title, 'The assistant declined a message');
  const run = app.db.prepare('SELECT status, reason FROM agent_runs').get();
  assert.equal(run.status, 'refusal');
  assert.match(run.reason, /cyber/);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM agent_runs').get().n, 1, 'una sola fila por ejecución');
}

test('rechazo del modelo: la conversación pasa a una persona en vez de responder "Got it!"', async () => {
  const app = await makeApp({ llm: scriptedLlm([refusal()]) });
  const r = await handleInbound(app, { channel: 'sms', address: '+13055550900', text: 'Where do I park?', now: NOW });
  assertHandedOff(app, r);
  // la IA se calla hasta que el panel la reactive
  assert.equal((await handleInbound(app, { channel: 'sms', address: '+13055550900', text: 'hello?', now: NOW })).reply, null);
});

test('rechazo del modelo a mitad del bucle de herramientas', async () => {
  const llm = scriptedLlm([toolUse('check_availability', { service: 'Cleaning' }), refusal()]);
  const app = await makeApp({ llm });
  const r = await handleInbound(app, { channel: 'sms', address: '+13055550901', text: 'Can I book a cleaning?', now: NOW });
  assert.equal(llm.calls.length, 2, 'se detiene tras el rechazo');
  assertHandedOff(app, r);
  assert.equal(app.db.prepare('SELECT tool_calls FROM agent_runs').get().tool_calls, 1);
});

test('runAgent lanza RefusalError con la categoría; sin stop_details queda como "unknown"', async () => {
  const app = await makeApp({ llm: scriptedLlm([{ stop_reason: 'refusal', content: [], stop_details: null }]) });
  const r = await handleInbound(app, { channel: 'web', address: 'sess_refusal01', text: 'hi', now: NOW });
  assert.equal(r.route.reason, 'refusal: unknown');
  const conversation = app.db.prepare('SELECT * FROM conversations').get();
  const contact = app.db.prepare('SELECT * FROM contacts').get();
  app.llm.messages.create = async () => ({ ...refusal('bio'), usage: { input_tokens: 1, output_tokens: 0 } });
  await assert.rejects(
    runAgent(app, { pack: app.packs.reception, model: 'm', tier: 'facil', conversation, contact, now: NOW }),
    e => e instanceof RefusalError && e.category === 'bio',
  );
  assert.deepEqual(app.db.prepare('SELECT status FROM agent_runs ORDER BY id').all().map(x => x.status), ['refusal', 'refusal']);
});
