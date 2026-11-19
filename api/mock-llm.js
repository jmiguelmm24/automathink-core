// Automathink Core — motor de prueba (LLM_PROVIDER=mock): imita la API de Claude sin coste ni clave.
// Sirve para enseñar el panel y probar el flujo. NO es inteligente: para la demo real usa ANTHROPIC_API_KEY.
const BOOK = /book|appointment|schedule|available|availability|opening|cita|agendar|reservar|turno|disponib/i;

export function mockLlm() {
  let n = 0;
  const id = () => `toolu_mock_${++n}`;
  return {
    messages: {
      async create({ messages, tools = [], system }) {
        const usage = { input_tokens: 400, output_tokens: 60 };
        const last = messages[messages.length - 1];
        const toolResult = Array.isArray(last.content) ? last.content.find(c => c.type === 'tool_result') : null;
        if (toolResult) {
          const r = JSON.parse(toolResult.content);
          let text = 'Done! Anything else I can help with?';
          if (r.slots?.length) text = `I have these openings: ${r.slots.slice(0, 3).map(s => s.label).join(' · ')}. Which one works for you?`;
          else if (r.slots) text = r.note || 'No openings soon, sorry.';
          else if (r.ok && r.when) text = `You're booked for ${r.service || 'your visit'} on ${r.when}. We'll text you a reminder.`;
          else if (r.ok === false) text = `Sorry, I couldn't do that (${r.error}).`;
          return { stop_reason: 'end_turn', content: [{ type: 'text', text }], usage };
        }
        const text = typeof last.content === 'string' ? last.content : '';
        if (tools.some(t => t.name === 'check_availability') && BOOK.test(text)) {
          const svc = (String(system?.[0]?.text || '').match(/# Services\n- ([^(]+)\(/) || [])[1]?.trim() || '';
          return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: id(), name: 'check_availability', input: { service: svc } }], usage };
        }
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Thanks for your message! (demo mode) How can I help — would you like to book a visit?' }], usage };
      },
    },
  };
}
