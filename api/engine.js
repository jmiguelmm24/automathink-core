// Automathink Core — motor de agentes: recibe un mensaje, pregunta al orquestador y ejecuta el agente con sus herramientas.
//
//   mensaje entrante ─► handleInbound()
//        ├─ STOP → baja (TCPA)            ├─ persona al mando → no responde la IA
//        └─ route() ─► pack ─► chooseModel() ─► runAgent() ⟲ herramientas (máx. 6 vueltas) ─► respuesta
//
// Todo queda registrado: mensajes, ejecuciones (tokens), actividad y avisos al dueño.
import { now as nowIso, logActivity, upsertContactConversation, addMessage, history } from './db.js';
import { route, chooseModel, haikuClassifier } from './orquestador.js';
import { TOOLS, toolDefs } from './tools/index.js';
import { notify } from './notify.js';
import { humanTime } from './time.js';

const MAX_TURNS = 6;
// Haiku/Sonnet 5.5 piensan por defecto (thinking adaptativo) y esos tokens cuentan contra max_tokens:
// con 600 la respuesta se cortaba o llegaba sin texto. Dejamos margen; el prompt ya pide respuestas cortas de SMS.
export const MAX_OUTPUT_TOKENS = 4096;
// Effort bajo: recomendado para respuestas cortas de chat/SMS (menos thinking, menos latencia y coste).
// No se envía `thinking`: en Sonnet 5.5 `{type:'disabled'}` devuelve 400.
export const AGENT_EFFORT = 'low';

// ---------------------------------------------------------------- prompt de sistema
// Bloque 1 (fijo por cliente, se cachea): reglas + perfil del negocio. Bloque 2: el agente concreto + fecha.
export function businessBlock(b) {
  const lines = [];
  const biz = b.business;
  lines.push(`# Business\nName: ${biz.name}\nIndustry: ${biz.industry || '-'}\nTimezone: ${biz.timezone}`);
  for (const k of ['address', 'phone', 'website']) if (biz[k]) lines.push(`${k[0].toUpperCase() + k.slice(1)}: ${biz[k]}`);
  if (biz.about) lines.push(`About: ${biz.about}`);
  const hours = Object.entries(b.hours).map(([d, r]) => `${d}: ${(r || []).join(', ') || 'closed'}`);
  if (hours.length) lines.push(`\n# Opening hours (local)\n${hours.join('\n')}`);
  if (b.services.length) lines.push(`\n# Services\n${b.services.map(s => `- ${s.name} (${s.duration_min} min${s.price ? ', ' + s.price : ''})${s.description ? ': ' + s.description : ''}`).join('\n')}`);
  if (b.faqs.length) lines.push(`\n# FAQs\n${b.faqs.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n')}`);
  if (b.policies.length) lines.push(`\n# Policies\n${b.policies.map(p => `- ${p}`).join('\n')}`);
  if (b.qualification.questions.length) lines.push(`\n# Qualification questions (ask naturally, one at a time)\n${b.qualification.questions.map(q => `- ${q}`).join('\n')}`);
  if (b.onboarding.steps.length) lines.push(`\n# Onboarding checklist\n${b.onboarding.steps.map(s => `- ${s.name || s}${s.how ? ': ' + s.how : ''}`).join('\n')}`);
  return lines.join('\n');
}

export function guardrails(b) {
  const a = b.assistant;
  return `You are ${a.name}, the AI assistant of ${b.business.name}. Tone: ${a.tone}
Rules (always):
- You are an AI assistant. Never claim to be human. If asked, say you're ${b.business.name}'s virtual assistant and a person can help if needed.
- Reply in the customer's language (${b.business.languages.join(' / ')}). Keep replies short: this is SMS/chat.
- Only help with this business (its services, bookings, questions). Politely decline unrelated or general-purpose requests.
- Never invent prices, availability, policies or facts. Use the business profile and your tools. If you don't know, offer to have the team follow up.
- No medical, legal or financial advice. Use handoff_to_human for emergencies, complaints or when they ask for a person.
- Never ask for card numbers, SSNs or passwords.
- One question at a time. Always move toward the next useful step (book, qualify, or answer).`;
}

export function systemPrompt(app, pack, now) {
  const b = app.business;
  return [
    { type: 'text', text: `${guardrails(b)}\n\n${businessBlock(b)}`, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `# Your role: ${pack.name}\n${pack.prompt}\n\nNow (business local time): ${humanTime(now, b.business.timezone)}` },
  ];
}

// ---------------------------------------------------------------- un agente con sus herramientas
export async function runAgent(app, { pack, model, tier, conversation, contact, now = new Date() }) {
  const msgs = history(app.db, conversation.id, 20)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.body }));
  // La API exige empezar por el usuario
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const tools = toolDefs(pack.tools || []);
  let inTok = 0, outTok = 0, calls = 0, reply = '', reason = null;
  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await app.llm.messages.create({
        model, max_tokens: MAX_OUTPUT_TOKENS, output_config: { effort: AGENT_EFFORT },
        system: systemPrompt(app, pack, now), messages: msgs,
        ...(tools.length ? { tools } : {}),
      });
      inTok += (res.usage?.input_tokens || 0) + (res.usage?.cache_read_input_tokens || 0) + (res.usage?.cache_creation_input_tokens || 0);
      outTok += res.usage?.output_tokens || 0;
      const uses = res.content.filter(c => c.type === 'tool_use');
      reply = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      if (res.stop_reason === 'max_tokens') {
        // Se agotó el límite (p. ej. por thinking): si hay texto se usa tal cual; si no, se registra y
        // handleInbound aplica la respuesta de reserva en vez de devolver una cadena vacía sin aviso.
        reason = reply ? 'max_tokens: reply truncated' : 'max_tokens: no text in reply';
        if (!reply) app.log?.warn({ model, pack: pack.id, turn }, 'respuesta cortada por max_tokens sin texto');
        break;
      }
      if (res.stop_reason !== 'tool_use' || !uses.length) break;
      msgs.push({ role: 'assistant', content: res.content });
      const results = [];
      for (const u of uses) {
        calls++;
        let out;
        const tool = TOOLS[u.name];
        if (!tool || !(pack.tools || []).includes(u.name)) out = { ok: false, error: `tool ${u.name} not allowed for this agent` };
        else {
          try { out = await tool.run({ app, contact, conversation, now }, u.input || {}); }
          catch (e) { out = { ok: false, error: 'internal error' }; app.log?.error({ err: String(e), tool: u.name }, 'fallo de herramienta'); }
        }
        results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) });
      }
      msgs.push({ role: 'user', content: results });
    }
    record(app, { conversation, pack, model, tier, inTok, outTok, calls, status: 'done', reason });
    return reply;
  } catch (e) {
    record(app, { conversation, pack, model, tier, inTok, outTok, calls, status: 'error', reason: String(e.message || e).slice(0, 300) });
    throw e;
  }
}

function record(app, { conversation, pack, model, tier, inTok, outTok, calls, status, reason = null }) {
  app.db.prepare(`INSERT INTO agent_runs (conversation_id, pack, model, tier, input_tokens, output_tokens, tool_calls, status, reason, created_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(conversation?.id ?? null, pack.id, model, tier, inTok, outTok, calls, status, reason, nowIso());
}

// ---------------------------------------------------------------- entrada única de todos los canales
// Devuelve { reply: string|null, pack?, route }
export async function handleInbound(app, { channel, address, text, name = null, now = new Date() }) {
  const { db, business } = app;
  text = String(text || '').trim().slice(0, 2000);
  if (!text) return { reply: null, route: { action: 'ignore', reason: 'vacío' } };
  const { contact, conversation } = upsertContactConversation(db, { channel, address, name });
  addMessage(db, { conversation_id: conversation.id, role: 'user', body: text });

  if (contact.opted_out) {
    if (/^\s*(start|unstop)\s*$/i.test(text)) {
      db.transaction(() => { db.prepare('UPDATE contacts SET opted_out = 0 WHERE id = ?').run(contact.id); logActivity(db, { entity_type: 'contact', entity_id: contact.id, action: 'opt_in' }); })();
      return finish(app, conversation, null, `You're subscribed again to ${business.business.name}. How can we help?`, { action: 'opt_in' }, channel);
    }
    return { reply: null, route: { action: 'ignore', reason: 'contacto dado de baja' } };
  }

  const classify = app.config.llmProvider === 'anthropic' ? haikuClassifier(app.llm) : null;
  const r = await route(app, { text, conversation, classify });

  if (r.action === 'opt_out') {
    db.transaction(() => {
      db.prepare('UPDATE contacts SET opted_out = 1 WHERE id = ?').run(contact.id);
      db.prepare(`UPDATE outbox SET status = 'cancelled' WHERE contact_id = ? AND status = 'pending'`).run(contact.id);
      logActivity(db, { entity_type: 'contact', entity_id: contact.id, action: 'opt_out' });
    })();
    return finish(app, conversation, null, `You've been unsubscribed from ${business.business.name} messages. Reply START to resubscribe.`, r, channel);
  }
  if (r.action === 'ignore') return { reply: null, route: r };
  if (r.action === 'handoff') {
    db.transaction(() => {
      db.prepare(`UPDATE conversations SET status = 'handoff' WHERE id = ?`).run(conversation.id);
      logActivity(db, { entity_type: 'conversation', entity_id: conversation.id, action: 'handoff', after: { reason: r.reason } });
    })();
    await notify(app, { kind: 'handoff', title: 'A customer needs a person', body: `${contact.name || contact.address}: "${text.slice(0, 200)}"` });
    return finish(app, conversation, null, business.handoff.message || `Thanks for reaching out. A member of the ${business.business.name} team will contact you shortly.`, r, channel);
  }

  const { model, tier, reason } = chooseModel(app, { pack: r.pack, text });
  let reply;
  try {
    reply = await runAgent(app, { pack: r.pack, model, tier, conversation, contact, now });
  } catch (e) {
    app.log?.error({ err: String(e) }, 'fallo del agente');
    reply = business.fallback_message || `Sorry, I'm having trouble right now. A member of our team will get back to you shortly.`;
    await notify(app, { kind: 'error', title: 'The assistant failed to reply', body: `${contact.address}: "${text.slice(0, 120)}"` });
  }
  return finish(app, conversation, r.pack.id, reply || 'Got it! Anything else I can help with?', { ...r, model, model_reason: reason }, channel);
}

// Guarda la respuesta. En el primer mensaje de la conversación añade el aviso de IA (AI Act / buenas prácticas en EE. UU.)
function finish(app, conversation, packId, reply, routeInfo, channel = 'sms') {
  const { db, business } = app;
  const fresh = db.prepare('SELECT disclosed FROM conversations WHERE id = ?').get(conversation.id);
  if (!fresh.disclosed && business.assistant.disclosure) {
    // En el chat web la bienvenida y la cabecera ya dicen que es una IA: no se repite
    if (channel !== 'web') reply = `${business.assistant.disclosure} ${reply}`;
    db.prepare('UPDATE conversations SET disclosed = 1 WHERE id = ?').run(conversation.id);
  }
  addMessage(db, { conversation_id: conversation.id, role: 'assistant', body: reply, pack: packId });
  if (packId) db.prepare('UPDATE conversations SET current_pack = ? WHERE id = ?').run(packId, conversation.id);
  return { reply, pack: packId, route: routeInfo };
}
