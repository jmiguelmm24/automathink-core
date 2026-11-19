// Automathink Core — arranque: una instancia por cliente (CLIENT_DIR apunta a su carpeta con business.yaml)
import { loadConfig } from './config.js';
import { buildApp } from './app.js';
import { startScheduler } from './scheduler.js';

const config = loadConfig();
const app = await buildApp({ config, logger: { level: process.env.LOG_LEVEL || 'info' } });
startScheduler(app);
await app.listen({ port: config.port, host: config.host });
app.log.info(`${app.business.business.name} · packs: ${Object.keys(app.packs).join(', ')} · IA: ${config.llmProvider}`);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); app.db.close(); process.exit(0); });
