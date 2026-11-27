// Automathink Core — ORQUESTADOR: decide qué agente ejecutor (pack) atiende cada mensaje y con qué modelo.
// Misma filosofía que el orquestador de BEXP OPS: lo más barato primero.
//  1. Reglas fijas (gratis): baja STOP, conversación en manos de una persona, palabras de "pasar a humano".
//  2. Continuidad: si el mensaje es corto ("yes", "2", "thursday") sigue el mismo agente que respondió antes.
//  3. Palabras clave de cada pack activo (cita/agendar → scheduler…).
//  4. Si nada encaja y hay varios packs conversacionales: Haiku clasifica (cuesta muy poco).
//  5. Por defecto: reception (o el primer pack conversacional).
// Modelo: nivel del pack (facil = Haiku, normal = Sonnet). Se sube a normal en mensajes delicados y se baja a
// facil si el cliente pasó su tope mensual de tokens (MONTHLY_TOKEN_CAP).
import { STOP_WORDS } from './channels/sms.js';

export const TIER_MODELS = { facil: 'claude-haiku-5-5', normal: 'claude-sonnet-5-5' };
// Precio USD por millón de tokens para el informe de costes (nov-2026). cacheRead = entrada leída de la caché,
// cacheWrite = entrada escrita en la caché de 5 min (1,25x la entrada). Haiku 5.5: tarifa de prompts ≤ 100K tokens.
export const MODEL_PRICES = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.10, cacheWrite: 2.50 },
};

const ESCALATE = /complain|angry|upset|refund|insurance claim|lawsuit|frustrat|molest|reclam|enfadad/i;
const FOLLOW_ON = /^\s*([0-9]{1,2}|yes|yeah|yep|ok|okay|sure|no|si|sí|vale|perfect[o]?|the (first|second|third|1st|2nd|3rd)( one)?|(mon|tue|wed|thu|fri|sat|sun)[a-z]*|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|\d{1,2}(:\d{2})?\s*(am|pm)?)\s*[.!]?\s*$/i;

const conversational = packs => Object.values(packs).filter(p => p.kind === 'conversational');

// Devuelve { action: 'opt_out' | 'ignore' | 'handoff' | 'agent', pack?, reason }
export async function route(app, { text, conversation, classify = null }) {
  if (STOP_WORDS.test(text)) return { action: 'opt_out', reason: 'palabra de baja (TCPA)' };
  if (conversation.status === 'handoff') return { action: 'ignore', reason: 'la conversación la lleva una persona' };
  const kw = app.business.handoff.keywords;
  if (kw.length && new RegExp(`\\b(${kw.join('|')})\\b`, 'i').test(text)) return { action: 'handoff', reason: 'palabra de pasar a humano' };

  const convPacks = conversational(app.packs);
  if (!convPacks.length) return { action: 'ignore', reason: 'no hay packs conversacionales activos' };
  const byId = id => convPacks.find(p => p.id === id);

  if (conversation.current_pack && byId(conversation.current_pack) && FOLLOW_ON.test(text))
    return { action: 'agent', pack: byId(conversation.current_pack), reason: 'continuidad' };

  const hits = convPacks.filter(p => p.keywordRe?.test(text));
  if (hits.length === 1) return { action: 'agent', pack: hits[0], reason: 'palabras clave' };
  if (hits.length > 1) {   // varios encajan: gana el de mayor prioridad
    hits.sort((a, b) => (b.route?.priority || 0) - (a.route?.priority || 0));
    return { action: 'agent', pack: hits[0], reason: 'palabras clave (prioridad)' };
  }
  if (convPacks.length > 1 && classify) {
    const id = await classify(text, convPacks).catch(() => null);
    if (byId(id)) return { action: 'agent', pack: byId(id), reason: 'clasificado por Haiku' };
  }
  if (conversation.current_pack && byId(conversation.current_pack)) return { action: 'agent', pack: byId(conversation.current_pack), reason: 'continuidad' };
  return { action: 'agent', pack: byId('reception') || convPacks[0], reason: 'por defecto' };
}

// Tokens del mes en curso (para el tope)
export function monthTokens(db) {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
  return db.prepare('SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS t FROM agent_runs WHERE created_at >= ?').get(start.toISOString()).t;
}

export function chooseModel(app, { pack, text }) {
  let tier = pack.tier || 'facil', reason = `nivel del pack ${pack.id}`;
  if (tier === 'facil' && ESCALATE.test(text)) { tier = 'normal'; reason = 'mensaje delicado → Sonnet'; }
  const cap = app.config.monthlyTokenCap;
  if (tier !== 'facil' && cap && monthTokens(app.db) >= cap) { tier = 'facil'; reason += ' · tope mensual → Haiku'; }
  return { tier, model: TIER_MODELS[tier], reason };
}

// Clasificador barato con Haiku: devuelve el id del pack o null.
// En Haiku 5.5 el thinking adaptativo viene activado y sus tokens cuentan en max_tokens: con un tope bajo la
// respuesta podía quedarse sin bloque de texto. Por eso se desactiva el thinking y se pide esfuerzo bajo.
// (budget_tokens, temperature/top_p/top_k no por defecto y el prefill del asistente devuelven 400 en Haiku 5.5.)
export const CLASSIFIER_MAX_TOKENS = 64;

// Normaliza la respuesta: minúsculas y sin puntuación ni comillas (se conservan letras, dígitos, '_' y '-').
const normalizeId = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim();

// Devuelve el id de pack que coincide exactamente con la respuesta (o con una única palabra de ella), si no null
export function parseClassifierReply(reply, packs) {
  const ids = new Map(packs.map(p => [normalizeId(p.id), p.id]));
  const clean = normalizeId(reply);
  if (!clean) return null;
  if (ids.has(clean)) return ids.get(clean);
  const found = [...new Set(clean.split(/\s+/).filter(w => ids.has(w)))];
  return found.length === 1 ? ids.get(found[0]) : null;
}

export function haikuClassifier(client) {
  return async (text, packs) => {
    const msg = await client.messages.create({
      model: TIER_MODELS.facil,
      max_tokens: CLASSIFIER_MAX_TOKENS,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low' },
      system: `Route a customer message to one agent. Reply with ONLY the agent id, nothing else. Agents:\n${packs.map(p => `- ${p.id}: ${p.description}`).join('\n')}`,
      messages: [{ role: 'user', content: String(text).slice(0, 800) }],
    });
    if (!msg || msg.stop_reason === 'refusal' || !Array.isArray(msg.content)) return null;
    const reply = msg.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return parseClassifierReply(reply, packs);
  };
}

// inTok es la entrada TOTAL (incluye lo leído y escrito en caché); se separa para cobrar cada parte a su precio
export const costUsd = (model, inTok, outTok, cacheRead = 0, cacheWrite = 0) => {
  const p = MODEL_PRICES[model];
  if (!p) return 0;
  const uncached = Math.max(0, inTok - cacheRead - cacheWrite);
  return (uncached * p.input + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite + outTok * p.output) / 1e6;
};
