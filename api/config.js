// Automathink Core — configuración: variables de entorno + perfil del negocio (clients/<cliente>/business.yaml)
// Una instancia = un cliente. Todo lo que cambia entre clientes vive en su business.yaml y en su .env.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';

export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT) || 3000,
    host: env.HOST || '127.0.0.1',
    dbPath: env.DB_PATH || './data/core.sqlite',
    clientDir: resolve(env.CLIENT_DIR || './clients/demo-dental'),
    adminUser: env.ADMIN_USER || '',
    adminPasswordHash: env.ADMIN_PASSWORD_HASH || '',
    sessionSecret: env.SESSION_SECRET || '',
    cookieSecure: env.COOKIE_SECURE === 'true',
    trustProxy: env.TRUST_PROXY === 'true' ? 1 : false,
    publicBaseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    // Motor de IA: anthropic (real) o mock (respuestas de prueba, gratis; para enseñar el panel sin clave)
    llmProvider: env.LLM_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock'),
    anthropicKey: env.ANTHROPIC_API_KEY || '',
    monthlyTokenCap: Number(env.MONTHLY_TOKEN_CAP) || 0,   // 0 = sin tope; al pasarlo todo va al modelo barato
    twilio: {
      sid: env.TWILIO_ACCOUNT_SID || '', token: env.TWILIO_AUTH_TOKEN || '', from: env.TWILIO_FROM || '',
      skipSignature: env.TWILIO_SKIP_SIGNATURE === 'true',   // SOLO en local
    },
    ownerPhone: env.OWNER_PHONE || '',
    notifyWebhookUrl: env.NOTIFY_WEBHOOK_URL || '',          // Slack, Make, n8n… recibe un JSON por aviso
    intakeToken: env.INTAKE_TOKEN || '',                     // protege /api/intake (formularios → back-office)
    schedulerMs: Number(env.SCHEDULER_MS) || 60000,
  };
}

// Valores por defecto: el business.yaml solo necesita lo que cambia
const DEFAULTS = {
  business: { timezone: 'America/New_York', languages: ['en', 'es'] },
  assistant: { name: 'Ava', tone: 'warm, brief and professional. Short SMS-style messages (max ~320 characters).' },
  hours: {},
  services: [],
  faqs: [],
  policies: [],
  handoff: { keywords: ['emergency', 'lawyer', 'attorney', 'complaint', 'refund', 'urgencia', 'abogado', 'queja'] },
  booking: { slot_step_min: 30, horizon_days: 14, reminder_hours_before: 24, min_notice_hours: 2 },
  followup: { touches_days: [1, 3, 7] },
  qualification: { questions: [] },
  onboarding: { steps: [] },
  packs: ['reception', 'scheduler'],
  kpis: { minutes_saved_per_conversation: 6, minutes_saved_per_booking: 8, hourly_cost_usd: 18 },
  chains: {},   // ajustes de las cadenas entre agentes (api/events.js); vacío = valores por defecto de cada pack
};

export function loadBusiness(clientDir) {
  const file = join(clientDir, 'business.yaml');
  if (!existsSync(file)) throw new Error(`No existe ${file}. Copia clients/_template/business.yaml y rellénalo.`);
  const raw = YAML.parse(readFileSync(file, 'utf8')) || {};
  const b = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    b[k] = Array.isArray(v) ? (raw[k] ?? v) : (typeof v === 'object' ? { ...v, ...(raw[k] || {}) } : (raw[k] ?? v));
  }
  if (!b.business.name) throw new Error('business.yaml: falta business.name');
  for (const s of b.services) s.duration_min = Number(s.duration_min) || 30;
  return b;
}
