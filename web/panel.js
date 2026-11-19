// Panel del cliente: impacto, conversaciones (con "tomar el control"), citas, leads y avisos. JS puro, sin build.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = iso => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const AGENT = { reception: 'Receptionist', scheduler: 'Scheduler', followup: 'Follow-up', onboarding: 'Onboarding', backoffice: 'Back-office', human: 'Your team' };

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (r.status === 401) { location.href = '/login.html'; throw new Error('no session'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
}

let days = 7, tab = 'convs', openConv = null;

async function loadKpis() {
  const r = await api(`/api/report?days=${days}`);
  const k = [
    ['Hours saved', r.hours_saved_estimate, `≈ $${r.value_saved_usd_estimate} of team time`, true],
    ['Conversations', r.conversations, `${r.ai_replies} AI replies`],
    ['After hours', r.after_hours_messages, 'messages while you were closed'],
    ['Bookings', r.bookings, 'made by the assistant'],
    ['New leads', r.new_leads, `${r.handoffs} passed to your team`],
    ['AI cost', `$${r.ai_cost_usd}`, `${r.ai_tokens.toLocaleString()} tokens`],
  ];
  $('#kpis').innerHTML = k.map(([l, v, s, dark]) => `<div class="kpi${dark ? ' dark' : ''}"><div class="eyebrow">${l}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`).join('');
  $('#assumptions').textContent = `Hours saved is an estimate: ${r.assumptions}.`;
}

async function renderConvs() {
  const list = await api('/api/conversations');
  if (!list.length) { $('#tab').innerHTML = '<div class="empty">No conversations yet. Open the chat and say hi 👋</div>'; return; }
  $('#tab').innerHTML = `<div class="split"><div class="list">${list.map(c => `
    <div class="item${c.id === openConv ? ' on' : ''}" data-id="${c.id}">
      <div class="who"><span>${esc(c.name || (c.channel === 'web' ? 'Web visitor #' + c.id : c.address))}</span>${c.status === 'handoff' ? '<span class="badge handoff">needs you</span>' : `<span class="badge">${esc(c.channel)}</span>`}</div>
      <div class="last">${esc(c.last)}</div></div>`).join('')}</div><div class="thread" id="thread"><div class="empty">Select a conversation</div></div></div>`;
  document.querySelectorAll('.item').forEach(el => el.onclick = () => { openConv = Number(el.dataset.id); renderConvs(); });
  if (openConv) renderThread(openConv);
}

async function renderThread(id) {
  const c = await api(`/api/conversations/${id}`);
  const handoff = c.status === 'handoff';
  $('#thread').innerHTML = `
    <div class="top"><div><b>${esc(c.name || (c.channel === 'web' ? 'Web visitor #' + c.id : c.address))}</b> <span class="badge">${esc(c.channel)}</span></div>
      <button id="toggle" class="${handoff ? 'primary' : ''}">${handoff ? 'Give back to AI' : 'Take over'}</button></div>
    <div class="msgs" id="msgs">${c.messages.map(m => `<div class="m ${m.role}">${esc(m.body)}<span class="meta">${m.role === 'assistant' ? esc(AGENT[m.pack] || 'AI') + ' · ' : ''}${when(m.created_at)}</span></div>`).join('')}</div>
    <form class="compose" id="compose"><input id="body" placeholder="${handoff ? 'Reply as your team…' : 'Take over to reply yourself'}" ${handoff ? '' : 'disabled'}><button class="primary" ${handoff ? '' : 'disabled'}>Send</button></form>`;
  const msgs = $('#msgs'); msgs.scrollTop = msgs.scrollHeight;
  $('#toggle').onclick = async () => { await api(`/api/conversations/${id}/status`, { method: 'POST', body: JSON.stringify({ status: handoff ? 'open' : 'handoff' }) }); renderConvs(); };
  $('#compose').onsubmit = async e => {
    e.preventDefault();
    const body = $('#body').value.trim(); if (!body) return;
    await api(`/api/conversations/${id}/reply`, { method: 'POST', body: JSON.stringify({ body }) });
    renderThread(id);
  };
}

const table = (cols, rows) => rows.length
  ? `<table><tr>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr>${rows.map(r => `<tr>${cols.map(c => `<td>${c[1](r)}</td>`).join('')}</tr>`).join('')}</table>`
  : '<div class="empty">Nothing here yet.</div>';

async function renderBookings() {
  $('#tab').innerHTML = table([['When', r => esc(when(r.starts_at))], ['Service', r => esc(r.service)], ['Customer', r => esc(r.name || r.address)], ['Status', r => `<span class="badge">${esc(r.status)}</span>`]], await api('/api/bookings'));
}
async function renderLeads() {
  $('#tab').innerHTML = table([['Lead', r => `${esc(r.name || r.address)}<div class="s" style="color:var(--muted);font-size:12px">${esc(r.email || '')}</div>`], ['Interest', r => esc(r.interest)],
    ['Score', r => r.score ? `<b>${r.score}</b>/10` : '–'], ['Status', r => `<span class="badge">${esc(r.status)}</span>`], ['Follow-ups', r => r.touches], ['Notes', r => esc(r.notes)]], await api('/api/leads'));
}
async function renderAlerts() {
  const rows = await api('/api/notifications');
  $('#tab').innerHTML = table([['When', r => esc(when(r.created_at))], ['Alert', r => `<b>${esc(r.title)}</b><div style="color:var(--muted);font-size:13px">${esc(r.body)}</div>`], ['Sent via', r => esc(r.sent_via || 'dashboard')]], rows);
  await api('/api/notifications/read', { method: 'POST', body: '{}' }); $('#unread').textContent = '';
}

const RENDER = { convs: renderConvs, bookings: renderBookings, leads: renderLeads, alerts: renderAlerts };
document.querySelectorAll('nav.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('nav.tabs button').forEach(x => x.classList.toggle('on', x === b)); tab = b.dataset.tab; RENDER[tab]();
});
document.querySelectorAll('.period button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.period button').forEach(x => x.classList.toggle('on', x === b)); days = Number(b.dataset.days); loadKpis();
});
$('#logout').onclick = async () => { await api('/api/logout', { method: 'POST', body: '{}' }); location.href = '/login.html'; };

(async () => {
  const me = await api('/api/me');
  $('#biz').textContent = `${me.business} · ${me.packs.map(p => p.name).join(' · ')}`;
  loadKpis(); RENDER[tab]();
  const n = (await api('/api/notifications')).filter(x => !x.read_at).length;
  if (n) $('#unread').innerHTML = `<span class="badge handoff">${n}</span>`;
  // Se refresca solo cada 10 s (para la demo en directo)
  setInterval(() => { loadKpis(); if (tab === 'convs') RENDER.convs(); }, 10000);
})();
