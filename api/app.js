// Automathink Core — servidor HTTP (Fastify): canales de entrada, panel del cliente y API.
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import Anthropic from '@anthropic-ai/sdk';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, logActivity, now as nowIso, upsertContactConversation, addMessage } from './db.js';
import { registerAuth, checkSessionSecret } from './auth.js';
import { loadBusiness } from './config.js';
import { loadPacks } from './packs.js';
import { handleInbound, runAgent } from './engine.js';
import { mockLlm } from './mock-llm.js';
import { sendSms, validTwilioSignature } from './channels/sms.js';
import { computeReport } from './reports.js';
import { upsertLead } from './tools/index.js';
import { TIER_MODELS } from './orquestador.js';
import { emit, chainEnabled } from './events.js';

const WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

export async function buildApp({ config, db = null, business = null, llm = null, logger = false }) {
  checkSessionSecret(config.sessionSecret, { log: { warn: m => console.warn(m) } });
  const app = Fastify({ logger, trustProxy: config.trustProxy, bodyLimit: 64 * 1024 });
  app.decorate('config', config);
  app.decorate('db', db || openDb(config.dbPath));
  app.decorate('business', business || loadBusiness(config.clientDir));
  app.decorate('packs', loadPacks(app.business.packs));
  app.decorate('reactions', null);   // reactions.js de los packs: se cargan al repartir el primer evento (api/events.js)
  app.decorate('llm', llm || (config.llmProvider === 'anthropic' ? new Anthropic({ apiKey: config.anthropicKey }) : mockLlm()));

  await app.register(cookie, { secret: config.sessionSecret || 'dev-secret-solo-para-local-no-usar-en-produccion' });
  await app.register(formbody);
  await app.register(rateLimit, { global: false });
  registerAuth(app, { config, db: app.db });
  await app.register(fstatic, { root: WEB_DIR, index: ['index.html'] });

  const B = () => app.business.business;

  // ------------------------------------------------------------ público
  app.get('/api/health', async () => ({ ok: true, business: B().name, packs: Object.keys(app.packs), llm: config.llmProvider }));

  app.get('/api/public/business', async () => ({
    name: B().name, industry: B().industry || '', assistant: app.business.assistant.name,
    welcome: app.business.assistant.welcome || `Hi! I'm ${app.business.assistant.name}, ${B().name}'s virtual assistant. How can I help?`,
  }));

  // Chat web (widget de la web del cliente y demo)
  app.post('/api/public/chat', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', required: ['session_id', 'message'], additionalProperties: false, properties: {
      session_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' }, message: { type: 'string', minLength: 1, maxLength: 1000 },
    } } },
  }, async req => {
    const r = await handleInbound(app, { channel: 'web', address: req.body.session_id, text: req.body.message });
    return { reply: r.reply, agent: r.pack || null };
  });

  // SMS entrante (Twilio). Responde al instante y contesta por la API (Twilio corta a los 15 s).
  app.post('/webhooks/twilio/sms', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
    const params = req.body || {};
    if (!config.twilio.skipSignature) {
      const url = `${config.publicBaseUrl}/webhooks/twilio/sms`;
      if (!validTwilioSignature(config.twilio.token, url, params, req.headers['x-twilio-signature'])) return reply.code(403).send('invalid signature');
    }
    const from = String(params.From || ''), text = String(params.Body || '');
    reply.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    if (!/^\+\d{8,15}$/.test(from)) return;
    try {
      const r = await handleInbound(app, { channel: 'sms', address: from, text });
      if (r.reply) await sendSms(config, from, r.reply);
    } catch (e) { app.log.error({ err: String(e) }, 'fallo procesando SMS'); }
  });

  // Back-office: formularios / CRM / Make → lead clasificado + primer toque inmediato (speed to lead)
  app.post('/api/intake', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', maxLength: 120 }, phone: { type: 'string', maxLength: 20 }, email: { type: 'string', maxLength: 160 },
      message: { type: 'string', maxLength: 2000 }, source: { type: 'string', maxLength: 80 }, consent_sms: { type: 'boolean' },
    } } },
  }, async (req, reply) => {
    if (!config.intakeToken || req.headers['x-intake-token'] !== config.intakeToken) return reply.code(401).send({ error: 'bad_token' });
    if (!app.packs.backoffice) return reply.code(404).send({ error: 'backoffice_pack_disabled' });
    const { name = null, phone = '', email = '', message = '', source = 'form', consent_sms = false } = req.body;
    const phoneOk = /^\+\d{8,15}$/.test(phone);
    if (!phoneOk && !email) return reply.code(400).send({ error: 'phone_or_email_required' });
    const { contact, conversation } = upsertContactConversation(app.db, phoneOk ? { channel: 'sms', address: phone, name } : { channel: 'web', address: `email:${email}`, name });
    if (email) app.db.prepare('UPDATE contacts SET email = ? WHERE id = ?').run(email, contact.id);
    addMessage(app.db, { conversation_id: conversation.id, role: 'user', body: `[${source}] ${name || ''} ${email || ''}: ${message || '(no message)'}`.trim() });
    const pack = app.packs.backoffice;
    try { await runAgent(app, { pack, model: TIER_MODELS[pack.tier || 'facil'], tier: pack.tier || 'facil', conversation, contact }); }
    catch (e) { app.log.warn({ err: String(e) }, 'back-office sin clasificar'); }
    // TCPA: solo se escribe por SMS si el formulario recogió el consentimiento
    const willTouch = Boolean(app.packs.followup && phoneOk && consent_sms);
    // Con la cadena "lead caliente" activa, el primer toque lo programa su reacción (packs/followup/reactions.js);
    // si el cliente la apaga en business.yaml, el formulario programa el toque inmediato como antes
    const hotLeadChain = chainEnabled(app, 'hot_lead');
    const lead = app.db.transaction(() => {
      const l = upsertLead(app.db, contact.id, { status: 'new', interest: message.slice(0, 120) || null });
      if (willTouch && !hotLeadChain) {
        app.db.prepare('UPDATE leads SET next_touch_at = ? WHERE id = ?').run(nowIso(), l.id);
        logActivity(app.db, { entity_type: 'lead', entity_id: l.id, action: 'schedule_touch', after: { reason: 'intake' } });
      }
      // Cadena "lead caliente": el pack de seguimiento decide cuándo tocar según la puntuación (api/events.js)
      emit(app.db, 'lead.scored', { contact_id: contact.id, payload: { lead_id: l.id, score: l.score ?? null, source: 'intake', consent_sms: Boolean(consent_sms), phone_ok: phoneOk } });
      return app.db.prepare('SELECT * FROM leads WHERE id = ?').get(l.id);
    })();
    return { ok: true, lead_id: lead.id, status: lead.status, score: lead.score, first_touch: willTouch };
  });

  // ------------------------------------------------------------ panel (con sesión)
  app.get('/api/me', async () => ({ business: B().name, assistant: app.business.assistant.name, packs: Object.values(app.packs).map(p => ({ id: p.id, name: p.name })) }));

  app.get('/api/report', async req => computeReport(app.db, app.business, { days: Math.min(Math.max(Number(req.query.days) || 7, 1), 365) }));

  app.get('/api/conversations', async () => app.db.prepare(`
    SELECT cv.id, cv.status, cv.current_pack, cv.updated_at, c.channel, c.address, c.name, c.opted_out,
      (SELECT body FROM messages m WHERE m.conversation_id = cv.id ORDER BY m.id DESC LIMIT 1) AS last
    FROM conversations cv JOIN contacts c ON c.id = cv.contact_id ORDER BY cv.updated_at DESC LIMIT 100`).all());

  app.get('/api/conversations/:id', async (req, reply) => {
    const cv = app.db.prepare('SELECT cv.*, c.channel, c.address, c.name FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE cv.id = ?').get(Number(req.params.id));
    if (!cv) return reply.code(404).send({ error: 'not_found' });
    return { ...cv, messages: app.db.prepare('SELECT role, body, pack, created_at FROM messages WHERE conversation_id = ? ORDER BY id').all(cv.id) };
  });

  app.post('/api/conversations/:id/status', { schema: { body: { type: 'object', required: ['status'], properties: { status: { enum: ['open', 'handoff', 'closed'] } } } } }, async (req, reply) => {
    const id = Number(req.params.id);
    const cur = app.db.prepare('SELECT status FROM conversations WHERE id = ?').get(id);
    if (!cur) return reply.code(404).send({ error: 'not_found' });
    app.db.transaction(() => {
      app.db.prepare('UPDATE conversations SET status = ? WHERE id = ?').run(req.body.status, id);
      logActivity(app.db, { entity_type: 'conversation', entity_id: id, action: 'status', before: cur, after: req.body, actor: config.adminUser || 'admin' });
    })();
    return { ok: true };
  });

  // Respuesta de una persona del equipo (la IA se queda callada mientras la conversación esté en "handoff")
  app.post('/api/conversations/:id/reply', { schema: { body: { type: 'object', required: ['body'], properties: { body: { type: 'string', minLength: 1, maxLength: 1000 } } } } }, async (req, reply) => {
    const cv = app.db.prepare('SELECT cv.id, c.channel, c.address, c.opted_out FROM conversations cv JOIN contacts c ON c.id = cv.contact_id WHERE cv.id = ?').get(Number(req.params.id));
    if (!cv) return reply.code(404).send({ error: 'not_found' });
    if (cv.opted_out) return reply.code(409).send({ error: 'contact_opted_out' });
    if (cv.channel === 'sms') await sendSms(config, cv.address, req.body.body);
    app.db.transaction(() => {
      addMessage(app.db, { conversation_id: cv.id, role: 'assistant', body: req.body.body, pack: 'human' });
      logActivity(app.db, { entity_type: 'conversation', entity_id: cv.id, action: 'human_reply', actor: config.adminUser || 'admin' });
    })();
    return { ok: true };
  });

  app.get('/api/bookings', async () => app.db.prepare(`SELECT b.id, b.service, b.starts_at, b.status, c.name, c.address FROM bookings b
    JOIN contacts c ON c.id = b.contact_id WHERE b.starts_at >= ? ORDER BY b.starts_at LIMIT 100`).all(new Date(Date.now() - 86400000).toISOString()));

  app.get('/api/leads', async () => app.db.prepare(`SELECT l.id, l.status, l.interest, l.notes, l.score, l.touches, l.next_touch_at, l.created_at, c.name, c.address, c.email
    FROM leads l JOIN contacts c ON c.id = l.contact_id ORDER BY l.updated_at DESC LIMIT 200`).all());

  app.get('/api/notifications', async () => app.db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT 50').all());
  app.post('/api/notifications/read', async () => { app.db.prepare('UPDATE notifications SET read_at = ? WHERE read_at IS NULL').run(nowIso()); return { ok: true }; });

  return app;
}
