// Chat web público (widget / demo). Cada navegador tiene su id de sesión; ?new=1 empieza una conversación nueva.
const msgs = document.getElementById('msgs');
const KEY = 'am_chat_session';
const newId = () => 'web_' + crypto.getRandomValues(new Uint32Array(3)).join('').slice(0, 24);
let session;
try {
  if (new URLSearchParams(location.search).has('new')) localStorage.removeItem(KEY);
  session = localStorage.getItem(KEY) || newId();
  localStorage.setItem(KEY, session);
} catch { session = newId(); }   // sin almacenamiento: una sesión por visita

function add(text, who) {
  const d = document.createElement('div');
  d.className = `m ${who}`; d.textContent = text;
  msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight;
  return d;
}

fetch('/api/public/business').then(r => r.json()).then(b => {
  document.title = `Chat · ${b.name}`;
  document.getElementById('name').textContent = `${b.assistant} · ${b.name}`;
  document.getElementById('av').textContent = (b.assistant || 'A')[0];
  add(b.welcome, 'bot');
});

document.getElementById('f').addEventListener('submit', async e => {
  e.preventDefault();
  const input = document.getElementById('t');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  add(text, 'me');
  const typing = add('typing…', 'typing');
  try {
    const r = await fetch('/api/public/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: session, message: text }) });
    const j = await r.json();
    typing.remove();
    if (r.status === 429) add('Too many messages, give me a second 🙂', 'bot');
    else if (j.reply) add(j.reply, 'bot');
  } catch { typing.remove(); add('Connection problem. Please try again.', 'bot'); }
});
