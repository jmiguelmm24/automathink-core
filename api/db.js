// Automathink Core — base de datos (SQLite con better-sqlite3). Una base por cliente.
// - Aplica las migraciones de api/migrations/ en orden al arrancar (igual que en BEXP OPS).
// - Cada escritura que cambia datos guarda una fila en `activity` en la MISMA transacción.
import Database from 'better-sqlite3';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function openDb(dbPath = './data/core.sqlite') {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set(db.prepare('SELECT name FROM migrations').all().map(r => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    db.transaction(() => {
      db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
    })();
  }
}

export const now = () => new Date().toISOString();

// Registra un cambio en el historial (llamar SIEMPRE dentro de la transacción de la escritura)
export function logActivity(db, { entity_type, entity_id = null, action, before = null, after = null, actor = 'agent' }) {
  db.prepare(`INSERT INTO activity (entity_type, entity_id, action, before, after, actor, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(entity_type, entity_id, action, before && JSON.stringify(before), after && JSON.stringify(after), actor, now());
}

export function getMeta(db, key, fallback = null) {
  const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return r ? JSON.parse(r.value) : fallback;
}
export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

// ---------------------------------------------------------------- contactos y conversaciones
// Busca o crea el contacto + su conversación abierta. Devuelve { contact, conversation }.
export function upsertContactConversation(db, { channel, address, name = null }) {
  return db.transaction(() => {
    let contact = db.prepare('SELECT * FROM contacts WHERE channel = ? AND address = ?').get(channel, address);
    if (!contact) {
      const { lastInsertRowid } = db.prepare('INSERT INTO contacts (channel, address, name, created_at) VALUES (?, ?, ?, ?)')
        .run(channel, address, name, now());
      contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(lastInsertRowid);
      logActivity(db, { entity_type: 'contact', entity_id: contact.id, action: 'create', after: { channel } });
    }
    let conversation = db.prepare(`SELECT * FROM conversations WHERE contact_id = ? AND status != 'closed' ORDER BY id DESC LIMIT 1`).get(contact.id);
    if (!conversation) {
      const t = now();
      const { lastInsertRowid } = db.prepare('INSERT INTO conversations (contact_id, created_at, updated_at) VALUES (?, ?, ?)').run(contact.id, t, t);
      conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(lastInsertRowid);
      logActivity(db, { entity_type: 'conversation', entity_id: conversation.id, action: 'create' });
    }
    return { contact, conversation };
  })();
}

export function addMessage(db, { conversation_id, role, body, pack = null }) {
  db.prepare('INSERT INTO messages (conversation_id, role, body, pack, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(conversation_id, role, body, pack, now());
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), conversation_id);
}

// Últimos N mensajes en orden cronológico (contexto para el modelo)
export const history = (db, conversation_id, limit = 20) =>
  db.prepare('SELECT role, body, pack FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(conversation_id, limit).reverse();
