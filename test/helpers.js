// Utilidades de test: app en memoria con el cliente de demo y un "LLM guionizado" (respuestas fijas, sin red).
import { buildApp } from '../api/app.js';
import { loadConfig, loadBusiness } from '../api/config.js';
import { openDb } from '../api/db.js';
import { hashPassword } from '../api/auth.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const demoBusiness = () => loadBusiness(join(ROOT, 'clients', 'demo-dental'));

// script: lista de funciones (req) => respuesta. Cada llamada a messages.create consume la siguiente.
export function scriptedLlm(script = []) {
  const calls = [];
  return {
    calls,
    messages: {
      async create(req) {
        calls.push(req);
        const step = script.shift();
        if (!step) return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 5 } };
        const r = typeof step === 'function' ? step(req) : step;
        return { usage: { input_tokens: 100, output_tokens: 20 }, ...r };
      },
    },
  };
}
export const text = t => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
export const toolUse = (name, input, id = `tu_${name}_${Math.random().toString(36).slice(2, 8)}`) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] });

export async function makeApp({ llm = scriptedLlm(), env = {}, business = demoBusiness() } = {}) {
  const config = loadConfig({
    SESSION_SECRET: 'x'.repeat(40), ADMIN_USER: 'admin', ADMIN_PASSWORD_HASH: hashPassword('contraseña-de-test'),
    LLM_PROVIDER: 'scripted', TWILIO_SKIP_SIGNATURE: 'true', INTAKE_TOKEN: 'tok-test', ...env,
  });
  const app = await buildApp({ config, db: openDb(':memory:'), business, llm });
  await app.ready();
  return app;
}

export async function login(app) {
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { user: 'admin', password: 'contraseña-de-test' } });
  return r.headers['set-cookie'];
}

// Un martes a las 10:00 de Miami (para que los tests no dependan del día en que se ejecutan)
export const TUESDAY_10AM_MIAMI = new Date('2026-11-24T15:00:00Z');
