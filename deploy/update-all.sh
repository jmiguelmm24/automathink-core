#!/bin/sh
# Automathink Core — actualiza el código, reconstruye la imagen y reinicia TODOS los clientes.
# También lo ejecuta GitHub Actions por SSH (clave limitada a este script, como en BEXP OPS).
#   /docker/automathink-core/deploy/update-all.sh            → todos
#   /docker/automathink-core/deploy/update-all.sh sonrisa    → solo uno
set -eu
CORE="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${CLIENTS_DIR:-/docker/clients}"

cd "$CORE"
git pull --ff-only
docker build -t automathink-core:latest .

for dir in "$BASE"/*/; do
  [ -f "$dir/docker-compose.yml" ] || continue
  slug="$(basename "$dir")"
  [ -n "${1:-}" ] && [ "$1" != "$slug" ] && continue
  echo "→ $slug"
  (cd "$dir" && docker compose up -d)
done
docker image prune -f >/dev/null
docker ps --filter name=am- --format 'table {{.Names}}\t{{.Status}}'
