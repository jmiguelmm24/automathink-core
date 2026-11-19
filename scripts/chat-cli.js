// Habla con el agente desde la terminal (para las 20 conversaciones de prueba antes del go-live).
// Uso: CLIENT_DIR=./clients/<cliente> npm run chat     (escribe "salir" para terminar)
// Usa una base en memoria: no ensucia los datos del cliente.
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from '../api/config.js';
import { buildApp } from '../api/app.js';
import { openDb } from '../api/db.js';
import { handleInbound } from '../api/engine.js';

const config = loadConfig({ ...process.env, SESSION_SECRET: 'x'.repeat(40) });
const app = await buildApp({ config, db: openDb(':memory:') });
const rl = readline.createInterface({ input: stdin, output: stdout });
const phone = '+15550000' + String(Date.now()).slice(-3);
console.log(`${app.business.business.name} · IA: ${config.llmProvider} · packs: ${Object.keys(app.packs).join(', ')}\n`);
for (;;) {
  const text = await rl.question('tú > ');
  if (/^(salir|exit|quit)$/i.test(text.trim())) break;
  const r = await handleInbound(app, { channel: 'sms', address: phone, text });
  const run = app.db.prepare('SELECT model, input_tokens, output_tokens, tool_calls FROM agent_runs ORDER BY id DESC LIMIT 1').get();
  console.log(`\n${app.business.assistant.name} > ${r.reply ?? '(sin respuesta: ' + r.route.reason + ')'}`);
  console.log(`   [${r.pack || r.route.action} · ${r.route.reason}${run ? ` · ${run.model} · ${run.input_tokens}+${run.output_tokens} tok · ${run.tool_calls} herramientas` : ''}]\n`);
}
rl.close(); process.exit(0);
