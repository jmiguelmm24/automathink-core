// Automathink Core — avisos al dueño del negocio (cita nueva, lead caliente, pasar a una persona).
// Siempre queda en la tabla `notifications` (se ve en el panel). Además, si está configurado:
//   OWNER_PHONE         → SMS al dueño
//   NOTIFY_WEBHOOK_URL  → POST JSON (Slack, Make, n8n, el CRM del cliente…)
import { now, logActivity } from './db.js';
import { sendSms } from './channels/sms.js';

export async function notify(app, { kind, title, body = '' }) {
  const { db, config } = app;
  const via = [];
  const id = db.transaction(() => {
    const { lastInsertRowid } = db.prepare('INSERT INTO notifications (kind, title, body, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, title, body, now());
    logActivity(db, { entity_type: 'notification', entity_id: Number(lastInsertRowid), action: 'create', after: { kind, title } });
    return Number(lastInsertRowid);
  })();

  const tasks = [];
  if (config.ownerPhone) tasks.push(sendSms(config, config.ownerPhone, `[${app.business.business.name}] ${title}${body ? ' — ' + body : ''}`.slice(0, 600)).then(() => via.push('sms')));
  if (config.notifyWebhookUrl) tasks.push(fetch(config.notifyWebhookUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ business: app.business.business.name, kind, title, body, at: now() }),
  }).then(r => { if (r.ok) via.push('webhook'); }));
  // Un aviso que falla no debe tumbar la conversación: se registra y sigue
  await Promise.allSettled(tasks).then(rs => rs.filter(r => r.status === 'rejected').forEach(r => app.log?.warn({ err: String(r.reason) }, 'aviso no enviado')));
  if (via.length) db.prepare('UPDATE notifications SET sent_via = ? WHERE id = ?').run(via.join(','), id);
  return id;
}
