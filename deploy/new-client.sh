#!/bin/sh
# Automathink Core — da de alta un cliente nuevo en el VPS en 1 minuto.
#
#   sudo /docker/automathink-core/deploy/new-client.sh <slug> <dominio> "<packs>"
#   ej: sudo ./deploy/new-client.sh sonrisa-dental sonrisa.automathink.io "reception,scheduler,reports"
#
# Crea /docker/clients/<slug>/ con: docker-compose.yml, .env (secretos generados) y client/business.yaml (plantilla).
# Después: editas business.yaml y el .env (Twilio, clave de IA, teléfono del dueño) y arrancas.
set -eu

SLUG="${1:-}"; DOMAIN="${2:-}"; PACKS="${3:-reception,scheduler,reports}"
CORE="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${CLIENTS_DIR:-/docker/clients}"
DIR="$BASE/$SLUG"

case "$SLUG" in ''|*[!a-z0-9-]*) echo "Uso: $0 <slug: minúsculas, números y guiones> <dominio> [packs]"; exit 1;; esac
[ -n "$DOMAIN" ] || { echo "Falta el dominio (ej: $SLUG.automathink.io)"; exit 1; }
[ -e "$DIR" ] && { echo "Ya existe $DIR"; exit 1; }
docker image inspect automathink-core:latest >/dev/null 2>&1 || { echo "Falta la imagen: ejecuta antes deploy/update-all.sh"; exit 1; }

mkdir -p "$DIR/client"
sed "s/__SLUG__/$SLUG/g" "$CORE/deploy/client-compose.yml" > "$DIR/docker-compose.yml"
# Plantilla del negocio con los packs vendidos
PACKS_YAML="[$(echo "$PACKS" | sed 's/,/, /g')]"
sed "s/^packs: .*/packs: $PACKS_YAML/" "$CORE/clients/_template/business.yaml" > "$DIR/client/business.yaml"

# Contraseña del panel: se muestra UNA vez; en el .env solo queda su hash
PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"
HASH="$(docker run --rm --entrypoint node automathink-core:latest -e "import('./api/auth.js').then(m=>console.log(m.hashPassword(process.argv[1])))" "$PASSWORD")"

umask 077
cat > "$DIR/.env" <<EOF
# $SLUG — creado $(date -u +%Y-%m-%dT%H:%MZ)
DOMAIN=$DOMAIN
PUBLIC_BASE_URL=https://$DOMAIN
ADMIN_USER=$SLUG
ADMIN_PASSWORD_HASH=$HASH
SESSION_SECRET=$(openssl rand -hex 32)
MASTER_KEY=$(openssl rand -hex 32)
INTAKE_TOKEN=$(openssl rand -hex 24)
TZ=America/New_York
# --- rellenar ---
ANTHROPIC_API_KEY=
MONTHLY_TOKEN_CAP=5000000
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM=
OWNER_PHONE=
NOTIFY_WEBHOOK_URL=
EOF

cat <<EOF

✅ Cliente $SLUG creado en $DIR
   Panel:  https://$DOMAIN      usuario: $SLUG    contraseña: $PASSWORD   (apúntala: no se vuelve a mostrar)

Siguientes pasos:
 1. DNS: registro A de $DOMAIN → IP de este VPS
 2. nano $DIR/client/business.yaml        (perfil del negocio)
 3. nano $DIR/.env                        (ANTHROPIC_API_KEY, Twilio, OWNER_PHONE)
 4. cd $DIR && docker compose up -d && docker compose logs -f
 5. Twilio → número → "A message comes in" → Webhook POST https://$DOMAIN/webhooks/twilio/sms
 6. Prueba: docker compose exec app node scripts/chat-cli.js   (20 conversaciones antes del go-live)
EOF
