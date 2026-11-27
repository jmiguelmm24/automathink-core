import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeApp, scriptedLlm, text, TUESDAY_10AM_MIAMI as NOW } from './helpers.js';
import { handleInbound } from '../api/engine.js';

// Haiku/Sonnet 5.5: thinking adaptativo por defecto; los tokens de thinking cuentan contra max_tokens.

test('runAgent: pide effort low, margen de tokens y no envía thinking', async () => {
  const llm = scriptedLlm([text('We have free parking behind the building.')]);
  const app = await makeApp({ llm });
  const r = await handleInbound(app, { channel: 'web', address: 'sess_params01', text: 'Where do I park?', now: NOW });
  assert.equal(r.reply, 'We have free parking behind the building.');
  assert.equal(llm.calls.length, 1);
  const req = llm.calls[0];
  assert.equal(req.output_config?.effort, 'low', 'effort dentro de output_config');
  assert.ok(!('effort' in req), 'effort no va en el nivel superior');
  assert.ok(req.max_tokens >= 2048, `max_tokens con margen para thinking (es ${req.max_tokens})`);
  assert.ok(!('thinking' in req), 'no se envía thinking (Sonnet 5.5 rechaza disabled)');
  const run = app.db.prepare('SELECT status, reason FROM agent_runs').get();
  assert.equal(run.status, 'done');
  assert.equal(run.reason, null);
});

test('runAgent: corte por max_tokens sin texto → respuesta de reserva, no vacía, y queda registrado', async () => {
  const llm = scriptedLlm([{ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] }]);
  const app = await makeApp({ llm });
  const r = await handleInbound(app, { channel: 'web', address: 'sess_params02', text: 'Where do I park?', now: NOW });
  assert.equal(typeof r.reply, 'string');
  assert.ok(r.reply.trim().length > 0, 'nunca se manda una respuesta vacía');
  assert.equal(r.reply, 'Got it! Anything else I can help with?');
  const run = app.db.prepare('SELECT status, reason FROM agent_runs').get();
  assert.equal(run.status, 'done');
  assert.match(run.reason, /max_tokens/);
  assert.match(run.reason, /no text/);
});

test('runAgent: corte por max_tokens con texto → se conserva el texto', async () => {
  const llm = scriptedLlm([{ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: 'Parking is behind the' }] }]);
  const app = await makeApp({ llm });
  const r = await handleInbound(app, { channel: 'web', address: 'sess_params03', text: 'Where do I park?', now: NOW });
  assert.equal(r.reply, 'Parking is behind the');
  assert.match(app.db.prepare('SELECT reason FROM agent_runs').get().reason, /truncated/);
});
