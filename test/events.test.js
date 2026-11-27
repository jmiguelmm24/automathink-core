// Eventos entre agentes: emit en la transacción, reparto, retrasos, reintentos y configuración por cliente
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emit, dispatchEvents, chainConfig, chainEnabled, MAX_ATTEMPTS } from '../api/events.js';
import { tick } from '../api/scheduler.js';
import { makeApp, demoBusiness } from './helpers.js';

const NOW = new Date('2026-11-24T15:00:00Z');
const status = (app, id) => app.db.prepare('SELECT status, attempts, run_after, last_error FROM events WHERE id = ?').get(id);

// Suscribe el pack followup a un evento de prueba con un handler sustituible
function subscribe(app, handler, { chain = 'test_chain', defaults = {} } = {}) {
  app.packs.followup.reacts_to = { 'test.happened': { handler: 'onTest', chain, defaults } };
  app.reactions = { followup: { onTest: handler } };
}

test('emit va en la misma transacción: si la escritura falla, no queda evento', async () => {
  const app = await makeApp();
  assert.throws(() => app.db.transaction(() => { emit(app.db, 'test.happened', { payload: { a: 1 } }); throw new Error('boom'); })());
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
  const id = app.db.transaction(() => emit(app.db, 'test.happened', { payload: { a: 1 } }))();
  assert.equal(status(app, id).status, 'pending');
  assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM activity WHERE entity_type = 'event' AND action = 'emit'`).get().n, 1);
});

test('reparte al pack suscrito con su configuración y marca done', async () => {
  const app = await makeApp();
  const seen = [];
  subscribe(app, async (ctx, ev) => { seen.push({ payload: ev.payload, config: ctx.config, now: ctx.now }); return { status: 'done' }; }, { defaults: { min_score: 8 } });
  const id = emit(app.db, 'test.happened', { contact_id: null, payload: { x: 2 } });
  assert.equal(await dispatchEvents(app, NOW), 1);
  assert.deepEqual(seen[0].payload, { x: 2 });
  assert.equal(seen[0].config.min_score, 8);
  assert.equal(seen[0].now, NOW);
  assert.equal(status(app, id).status, 'done');
  assert.equal(await dispatchEvents(app, NOW), 0, 'no se repite');
});

test('sin suscriptor o con la cadena apagada en business.yaml: skipped', async () => {
  const app = await makeApp({ business: { ...demoBusiness(), chains: { test_chain: { enabled: false } } } });
  subscribe(app, async () => { throw new Error('no debería llamarse'); });
  assert.equal(chainEnabled(app, 'test_chain'), false);
  const a = emit(app.db, 'test.happened');
  const b = emit(app.db, 'nadie.escucha');
  await dispatchEvents(app, NOW);
  assert.equal(status(app, a).status, 'skipped');
  assert.equal(status(app, b).status, 'skipped');
});

test('business.yaml ajusta los valores por defecto de la cadena', async () => {
  const app = await makeApp({ business: { ...demoBusiness(), chains: { test_chain: { min_score: 6 } } } });
  assert.deepEqual(chainConfig(app, 'test_chain', { min_score: 8, after_hours: 24 }), { enabled: true, min_score: 6, after_hours: 24 });
});

test('status later: el evento espera hasta run_after', async () => {
  const app = await makeApp();
  const later = new Date(NOW.getTime() + 24 * 3600000);
  let calls = 0;
  subscribe(app, async () => (++calls === 1 ? { status: 'later', run_after: later.toISOString() } : { status: 'done' }));
  const id = emit(app.db, 'test.happened');
  assert.equal(await dispatchEvents(app, NOW), 0);
  assert.equal(status(app, id).status, 'pending');
  assert.equal(await dispatchEvents(app, new Date(NOW.getTime() + 3600000)), 0, 'aún no toca');
  assert.equal(await dispatchEvents(app, later), 1);
  assert.equal(status(app, id).status, 'done');
  assert.equal(calls, 2);
});

test('un handler que falla se reintenta y al final queda failed con aviso al dueño', async () => {
  const app = await makeApp();
  subscribe(app, async () => { throw new Error('servicio caído'); });
  const id = emit(app.db, 'test.happened');
  let t = NOW;
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    await dispatchEvents(app, t);
    const s = status(app, id);
    assert.equal(s.status, 'pending');
    assert.equal(s.attempts, i);
    assert.match(s.last_error, /servicio caído/);
    t = new Date(s.run_after);
  }
  await dispatchEvents(app, t);
  assert.equal(status(app, id).status, 'failed');
  assert.equal(app.db.prepare(`SELECT COUNT(*) n FROM notifications WHERE kind = 'error'`).get().n, 1);
});

test('tick reparte eventos antes que el resto y lo informa', async () => {
  const app = await makeApp();
  subscribe(app, async () => ({ status: 'done' }));
  emit(app.db, 'test.happened');
  const r = await tick(app, NOW);
  assert.equal(r.events, 1);
});
