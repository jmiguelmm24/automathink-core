// Arranca el cliente de demo (Sonrisa Dental) en local con una base aparte y contraseña aleatoria.
// Uso: npm run demo   → http://127.0.0.1:3000  (panel)  ·  http://127.0.0.1:3000/chat.html  (chat)
// Con ANTHROPIC_API_KEY en .env usa Claude de verdad; sin ella, el motor de prueba (gratis, respuestas fijas).
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../api/auth.js';
import { loadConfig } from '../api/config.js';
import { buildApp } from '../api/app.js';
import { startScheduler } from '../api/scheduler.js';

const password = randomBytes(9).toString('base64url');
const config = loadConfig({
  ...process.env,
  CLIENT_DIR: process.env.CLIENT_DIR || './clients/demo-dental',
  DB_PATH: process.env.DEMO_DB_PATH || './data/demo.sqlite',
  ADMIN_USER: 'demo', ADMIN_PASSWORD_HASH: hashPassword(password),
  SESSION_SECRET: randomBytes(32).toString('hex'),
  INTAKE_TOKEN: process.env.INTAKE_TOKEN || 'demo-intake-token',
  TWILIO_SKIP_SIGNATURE: 'true',
});
const app = await buildApp({ config, logger: { level: 'warn' } });
startScheduler(app);
await app.listen({ port: config.port, host: config.host });
const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
console.log(`\n  ${app.business.business.name} — demo
  Panel:  ${url}   usuario: demo   contraseña: ${password}
  Chat:   ${url}/chat.html
  IA:     ${config.llmProvider === 'anthropic' ? 'Claude (real)' : 'motor de prueba (pon ANTHROPIC_API_KEY en .env para la demo real)'}
  Packs:  ${Object.keys(app.packs).join(', ')}\n`);
