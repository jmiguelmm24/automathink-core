-- Eventos entre agentes: lo que hace un pack (cita creada, cancelada, lead puntuado) queda aquí en la MISMA
-- transacción que la escritura, y el programador lo reparte a los packs que reaccionan (api/events.js).
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                       -- p. ej. booking.created, booking.cancelled, lead.scored
  contact_id INTEGER REFERENCES contacts(id),
  payload TEXT NOT NULL DEFAULT '{}',       -- JSON
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | done | skipped | failed
  attempts INTEGER NOT NULL DEFAULT 0,
  run_after TEXT,                           -- NULL = en cuanto pase el programador
  last_error TEXT,
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX events_due ON events(status, run_after);
