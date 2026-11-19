// Automathink Core — inicio de sesión del panel (copiado de BEXP OPS, mismo modelo de seguridad)
// Credenciales SOLO en .env:
//   ADMIN_USER=admin
//   ADMIN_PASSWORD_HASH=scrypt:...   (genera con: npm run hash-password)
//   SESSION_SECRET=...               (cadena aleatoria larga; cambiarla cierra todas las sesiones)
//   COOKIE_SECURE=true               (en el VPS con HTTPS; en local false)
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { logActivity, now } from './db.js';

export const COOKIE = 'am_session';
const SESSION_DAYS = 7;
const KEYLEN = 64;

// ---------------------------------------------------------------- contraseñas
// Formato "scrypt:<sal>:<hash>" en base64url (sin "$", que da problemas en .env y Docker)
export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN);
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  const [algo, saltB64, hashB64] = String(stored || '').split(':');
  if (algo !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = scryptSync(String(password), Buffer.from(saltB64, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sameText = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- secreto de sesión
// En producción (NODE_ENV=production) un secreto corto o vacío es un error de arranque; en dev/tests solo un aviso.
export function checkSessionSecret(secret, { env = process.env, log } = {}) {
  if (String(secret || '').length >= 32) return;
  const msg = 'SESSION_SECRET debe tener al menos 32 caracteres (genera uno con: openssl rand -hex 32)';
  if (env.NODE_ENV === 'production') throw new Error(`${msg}. Es obligatorio en producción.`);
  log?.warn(msg);
}

// ---------------------------------------------------------------- sesiones (tabla `sessions`; la cookie firmada lleva solo el id)
// Lee la sesión de la cookie: firma válida + la fila existe + no ha caducado. Si no, null.
export function readSession(request, db) {
  const raw = request.cookies?.[COOKIE];
  if (!raw) return null;
  const { valid, value } = request.unsignCookie(raw);
  if (!valid || !value) return null;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE token = ?').get(value);
  return row && row.expires_at > Date.now() ? { user: 'admin', expires: row.expires_at, token: value } : null;
}

// Crea la sesión (+ actividad en la misma transacción) y limpia las caducadas. Devuelve { token, expires }.
function createSession(db, actor) {
  const token = randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 86400000;
  db.transaction(() => {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    const { lastInsertRowid } = db.prepare('INSERT INTO sessions (token, expires_at, created_at) VALUES (?, ?, ?)').run(token, expires, now());
    logActivity(db, { entity_type: 'session', entity_id: Number(lastInsertRowid), action: 'login', actor });
  })();
  return { token, expires };
}

// Borra la sesión de la cookie (+ actividad). No hace nada si ya no existe.
function destroySession(db, token, actor) {
  db.transaction(() => {
    const row = db.prepare('SELECT id FROM sessions WHERE token = ?').get(token);
    if (!row) return;
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id);
    logActivity(db, { entity_type: 'session', entity_id: row.id, action: 'logout', actor });
  })();
}

// Rutas que se pueden ver sin sesión (la pantalla de login y sus recursos)
const PUBLIC = [/^\/login\.html$/, /^\/login\.js$/, /^\/styles\.css$/, /^\/brand\.css$/, /^\/icons\//, /^\/api\/login$/, /^\/api\/health$/,
  // Canales de entrada: los protege su propia firma (Twilio) o el límite de peticiones (chat web)
  /^\/webhooks\/twilio\/sms$/, /^\/chat(\.html|\.js)?$/, /^\/api\/public\/chat$/, /^\/api\/public\/business$/,
  /^\/api\/intake$/];   // formularios → back-office: lo protege INTAKE_TOKEN (cabecera x-intake-token)

// Registra login/logout y protege todo lo demás
export function registerAuth(app, { config, db }) {
  const configured = Boolean(config.adminUser && config.adminPasswordHash);
  if (!configured) app.log.warn('Login sin configurar: define ADMIN_USER y ADMIN_PASSWORD_HASH en .env (npm run hash-password)');

  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0];
    if (PUBLIC.some(re => re.test(path))) return;
    if (readSession(request, db)) return;
    // Sin sesión: las páginas redirigen al login; todo lo demás (API, WebSocket, código de la app,
    // imágenes) responde 401. Solo lo de PUBLIC se ve sin iniciar sesión.
    if (path === '/' || path === '/index.html') return reply.redirect('/login.html');
    return reply.code(401).send({ error: 'no_session' });
  });

  app.post('/api/login', {
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },   // contra fuerza bruta
    schema: {
      body: {
        type: 'object', required: ['user', 'password'], additionalProperties: false,
        properties: { user: { type: 'string', minLength: 1, maxLength: 100 }, password: { type: 'string', minLength: 1, maxLength: 200 } },
      },
    },
  }, async (request, reply) => {
    if (!configured) return reply.code(503).send({ error: 'login_not_configured' });
    const { user, password } = request.body;
    const ok = sameText(user, config.adminUser) & verifyPassword(password, config.adminPasswordHash); // sin cortocircuito
    if (!ok) return reply.code(401).send({ error: 'invalid_credentials' });
    const { token, expires } = createSession(db, config.adminUser);
    reply.setCookie(COOKIE, token, {
      signed: true, httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/',
      expires: new Date(expires),
    });
    return { ok: true };
  });

  app.post('/api/logout', async (request, reply) => {
    const session = readSession(request, db);
    if (session) destroySession(db, session.token, config.adminUser);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/session', async request => ({ authenticated: true, user: config.adminUser, expires: readSession(request, db)?.expires }));
}
