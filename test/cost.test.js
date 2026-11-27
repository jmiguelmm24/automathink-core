// Coste de IA con caché: las lecturas de caché no se cobran como entrada normal
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costUsd, MODEL_PRICES } from '../api/orquestador.js';
import { handleInbound } from '../api/engine.js';
import { computeReport } from '../api/reports.js';
import { makeApp, scriptedLlm } from './helpers.js';

const NOW = new Date('2026-11-24T15:00:00Z'); // martes 10:00 en Miami
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≈ ${b}`);

test('costUsd: sin caché, igual que antes; con caché, cada parte a su precio', () => {
  const p = MODEL_PRICES['claude-sonnet-5-5'];
  close(costUsd('claude-sonnet-5-5', 1_000_000, 0), p.input);
  close(costUsd('claude-sonnet-5-5', 0, 1_000_000), p.output);
  // 1M de entrada total: 900K leídos de caché + 100K normales
  close(costUsd('claude-sonnet-5-5', 1_000_000, 0, 900_000, 0), (100_000 * p.input + 900_000 * p.cacheRead) / 1e6);
  // escritura en caché: 1,25x la entrada
  close(costUsd('claude-haiku-5-5', 1_000_000, 0, 0, 1_000_000), MODEL_PRICES['claude-haiku-5-5'].cacheWrite);
  assert.ok(costUsd('claude-sonnet-5-5', 1_000_000, 0, 900_000, 0) < costUsd('claude-sonnet-5-5', 1_000_000, 0) / 5, 'la caché abarata');
  assert.equal(costUsd('modelo-desconocido', 1000, 1000), 0);
});

test('runAgent guarda los tokens de caché y el informe los valora aparte', async () => {
  const usage = { input_tokens: 50, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1000, output_tokens: 40 };
  const app = await makeApp({ llm: scriptedLlm([{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Free parking behind the building.' }], usage }]) });
  await handleInbound(app, { channel: 'web', address: 'sess_cost01', text: 'Where do I park?', now: NOW });
  const run = app.db.prepare('SELECT model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens FROM agent_runs').get();
  assert.equal(run.input_tokens, 10_050, 'input_tokens sigue siendo la entrada total');
  assert.equal(run.cache_read_tokens, 9000);
  assert.equal(run.cache_write_tokens, 1000);
  app.db.prepare('UPDATE agent_runs SET created_at = ?').run(NOW.toISOString());
  const r = computeReport(app.db, app.business, { days: 7, now: new Date('2026-11-26T00:00:00Z') });
  const expected = costUsd(run.model, 10_050, 40, 9000, 1000);
  assert.ok(expected < costUsd(run.model, 10_050, 40), 'más barato que cobrar todo como entrada');
  assert.equal(r.ai_cost_usd, Math.round(expected * 100) / 100);
  assert.equal(r.ai_tokens, 10_090);
});
