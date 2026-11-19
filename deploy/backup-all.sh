#!/bin/sh
# Copia diaria de la base de cada cliente (SQLite .backup en caliente) a /docker/backups/<cliente>/. Guarda 14 días.
# Cron (root):  15 4 * * *  /docker/automathink-core/deploy/backup-all.sh
set -eu
BASE="${CLIENTS_DIR:-/docker/clients}"; OUT="${BACKUPS_DIR:-/docker/backups}"
STAMP="$(date -u +%Y%m%d)"
for dir in "$BASE"/*/; do
  slug="$(basename "$dir")"
  docker ps --format '{{.Names}}' | grep -qx "am-$slug" || continue
  mkdir -p "$OUT/$slug"
  docker exec "am-$slug" node -e "const D=require('better-sqlite3');new D('/app/data/core.sqlite',{readonly:true}).backup('/tmp/b.sqlite').then(()=>process.exit(0))"
  docker cp "am-$slug:/tmp/b.sqlite" "$OUT/$slug/core-$STAMP.sqlite"
  docker cp "am-$slug:/app/data/master.key" "$OUT/$slug/master.key" 2>/dev/null || true
  find "$OUT/$slug" -name 'core-*.sqlite' -mtime +14 -delete
done
