// Pruebas del clasificador Haiku (sin base de datos: cliente falso que imita client.messages.create)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haikuClassifier, CLASSIFIER_MAX_TOKENS, TIER_MODELS } from '../api/orquestador.js';

const PACKS = [
  { id: 'reception', description: 'General questions' },
  { id: 'scheduler', description: 'Book, move or cancel appointments' },
  { id: 'lead-followup', description: 'Follow up on new leads' },
];

// Cliente falso: guarda la petición y devuelve la respuesta indicada
function fakeClient(response) {
  const calls = [];
  return {
    calls,
    messages: { create: async req => { calls.push(req); return response; } },
  };
}
const reply = (text, stop_reason = 'end_turn') => ({ content: [{ type: 'text', text }], stop_reason });

test('clasificador: petición sin thinking, esfuerzo bajo y max_tokens moderado', async () => {
  const client = fakeClient(reply('scheduler'));
  await haikuClassifier(client)('I want to book a cleaning', PACKS);
  assert.equal(client.calls.length, 1);
  const req = client.calls[0];
  assert.equal(req.model, TIER_MODELS.facil);
  assert.deepEqual(req.thinking, { type: 'disabled' });
  assert.deepEqual(req.output_config, { effort: 'low' });
  assert.equal(req.max_tokens, CLASSIFIER_MAX_TOKENS);
  assert.ok(req.max_tokens >= 64);
  assert.equal(req.temperature, undefined);
  assert.ok(!req.messages.some(m => m.role === 'assistant'), 'sin prefill');
  assert.match(req.system, /- scheduler: /);
});

test('clasificador: devuelve el id válido', async () => {
  assert.equal(await haikuClassifier(fakeClient(reply('scheduler')))('x', PACKS), 'scheduler');
  assert.equal(await haikuClassifier(fakeClient(reply('lead-followup')))('x', PACKS), 'lead-followup');
});

test('clasificador: tolera mayúsculas, puntuación y comillas', async () => {
  assert.equal(await haikuClassifier(fakeClient(reply('Scheduler.')))('x', PACKS), 'scheduler');
  assert.equal(await haikuClassifier(fakeClient(reply('  "RECEPTION"\n')))('x', PACKS), 'reception');
  assert.equal(await haikuClassifier(fakeClient(reply('`scheduler`')))('x', PACKS), 'scheduler');
});

test('clasificador: id desconocido o ambiguo → null', async () => {
  assert.equal(await haikuClassifier(fakeClient(reply('billing')))('x', PACKS), null);
  assert.equal(await haikuClassifier(fakeClient(reply('reception or scheduler')))('x', PACKS), null);
});

test('clasificador: sin texto, max_tokens sin texto o refusal → null', async () => {
  assert.equal(await haikuClassifier(fakeClient({ content: [], stop_reason: 'end_turn' }))('x', PACKS), null);
  assert.equal(await haikuClassifier(fakeClient({ content: [], stop_reason: 'max_tokens' }))('x', PACKS), null);
  assert.equal(await haikuClassifier(fakeClient({ content: [{ type: 'thinking', thinking: '...' }], stop_reason: 'max_tokens' }))('x', PACKS), null);
  assert.equal(await haikuClassifier(fakeClient(reply('scheduler', 'refusal')))('x', PACKS), null);
  assert.equal(await haikuClassifier(fakeClient(reply('   ')))('x', PACKS), null);
});
