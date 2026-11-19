-- Automathink Core — esquema inicial (una base de datos por cliente)

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Historial de todo lo que cambia (se escribe en la misma transacción que el cambio)
CREATE TABLE activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL, entity_id INTEGER, action TEXT NOT NULL,
  before TEXT, after TEXT, actor TEXT NOT NULL, created_at TEXT NOT NULL
);

-- Sesiones del panel (la cookie firmada solo lleva el token)
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL
);

-- Personas que escriben al negocio (por teléfono o por id del chat web)
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,            -- sms | web | whatsapp
  address TEXT NOT NULL,            -- teléfono E.164 o id de sesión web
  name TEXT, email TEXT,
  opted_out INTEGER NOT NULL DEFAULT 0,   -- respondió STOP (TCPA): no se le escribe más
  created_at TEXT NOT NULL,
  UNIQUE (channel, address)
);

CREATE TABLE conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'open',    -- open | handoff (lo lleva una persona) | closed
  current_pack TEXT,                      -- último agente que respondió
  disclosed INTEGER NOT NULL DEFAULT 0,   -- ya se avisó de que es una IA
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,                     -- user | assistant | system
  body TEXT NOT NULL,
  pack TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_conv ON messages(conversation_id, id);

CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  status TEXT NOT NULL DEFAULT 'new',     -- new | qualified | booked | won | lost | nurturing
  interest TEXT, notes TEXT, score INTEGER,
  touches INTEGER NOT NULL DEFAULT 0,     -- toques de seguimiento enviados
  next_touch_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (contact_id)
);

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  service TEXT NOT NULL,
  starts_at TEXT NOT NULL,                -- ISO en UTC
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'confirmed',   -- confirmed | cancelled | no_show | done
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  external_id TEXT,                       -- id en Google Calendar u otro
  created_at TEXT NOT NULL
);
CREATE INDEX bookings_start ON bookings(starts_at);

-- Cada llamada a un modelo: para costes, informe y tope de gasto
CREATE TABLE agent_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER,
  pack TEXT NOT NULL, model TEXT NOT NULL, tier TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, reason TEXT,
  created_at TEXT NOT NULL
);

-- Avisos al dueño del negocio (cita nueva, lead caliente, pasar a humano)
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
  sent_via TEXT, created_at TEXT NOT NULL, read_at TEXT
);

-- Mensajes salientes programados (recordatorios, seguimientos)
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  body TEXT NOT NULL, kind TEXT NOT NULL,
  send_at TEXT NOT NULL, sent_at TEXT, status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
CREATE INDEX outbox_due ON outbox(status, send_at);
