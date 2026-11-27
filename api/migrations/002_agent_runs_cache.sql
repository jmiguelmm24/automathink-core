-- Tokens de caché por ejecución: las lecturas de caché cuestan una fracción de la entrada normal y las escrituras
-- un poco más. input_tokens sigue siendo la entrada TOTAL (incluye estas dos) para no cambiar el tope mensual
-- ni las filas antiguas, que quedan con 0 y se valoran como antes.
ALTER TABLE agent_runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agent_runs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
