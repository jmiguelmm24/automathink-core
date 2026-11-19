# Automathink Core en el VPS de Hostinger

Mismo VPS y mismo patrón que BEXP OPS: Ubuntu + Docker + **Traefik de Hostinger** (`/docker/traefik`, puertos 80/443, Let's Encrypt automático). Cada cliente es un contenedor `am-<cliente>` enganchado a Traefik por etiquetas. Ninguno publica puertos.

> **Recomendación:** clientes de pago en un **segundo VPS**, separado de BEXP. Un fallo o una actualización de BEXP no debe tocar a clientes. Un KVM 2 debería aguantar ~10-15 clientes pequeños (cada contenedor tiene tope de 256 MB): mide con el primero.

```
/docker/automathink-core/          ← este repo (código + imagen automathink-core:latest)
/docker/clients/<cliente>/         ← uno por cliente
    docker-compose.yml             ← de deploy/client-compose.yml
    .env                           ← secretos del cliente (600)
    client/business.yaml           ← perfil del negocio
/docker/backups/<cliente>/         ← copias diarias
```

## 1. Una vez por VPS

```bash
# Clave de solo lectura para clonar el repo privado (igual que BEXP OPS: GitHub → Deploy keys, sin write)
ssh-keygen -t ed25519 -f /root/.ssh/github_core -N "" -C "vps-automathink-core"
printf 'Host github-core\n  HostName github.com\n  IdentityFile /root/.ssh/github_core\n  IdentitiesOnly yes\n' >> /root/.ssh/config
cat /root/.ssh/github_core.pub                     # → GitHub: automathink-core → Settings → Deploy keys

git clone git@github-core:<owner>/automathink-core.git /docker/automathink-core
/docker/automathink-core/deploy/update-all.sh      # construye la imagen
( crontab -l 2>/dev/null; echo "15 4 * * * /docker/automathink-core/deploy/backup-all.sh" ) | crontab -
```

**Dominio:** un registro DNS comodín `*.automathink.io → IP del VPS` y cada cliente tiene subdominio sin tocar más el DNS.

## 2. Por cada cliente nuevo (≈ 1 minuto + rellenar el perfil)

```bash
/docker/automathink-core/deploy/new-client.sh sonrisa-dental sonrisa.automathink.io "reception,scheduler,followup,reports"
nano /docker/clients/sonrisa-dental/client/business.yaml
nano /docker/clients/sonrisa-dental/.env
cd /docker/clients/sonrisa-dental && docker compose up -d && docker compose logs -f
docker compose exec app node scripts/chat-cli.js   # 20 conversaciones de prueba antes del go-live
```
Cambiar el perfil del negocio = editar `business.yaml` y `docker compose restart`.

## 3. Twilio (SMS, EE. UU.) — empezar el primer día: el registro tarda

1. Número local del área del cliente.
2. **A2P 10DLC**: registrar *Brand* (empresa del cliente, EIN) + *Campaign* (uso: "Customer care / appointment reminders"). Sin aprobar, los SMS se bloquean o filtran.
3. Número → Messaging → *A message comes in* → Webhook `POST https://<dominio>/webhooks/twilio/sms`.
4. En el `.env`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `PUBLIC_BASE_URL` (debe coincidir exactamente con la URL del webhook: se usa para verificar la firma).

## 4. Formularios / CRM → back-office

`POST https://<dominio>/api/intake` con cabecera `x-intake-token: <INTAKE_TOKEN>` y JSON
`{ "name", "phone": "+1…", "email", "message", "source", "consent_sms": true }`.
Sirve para Make, Zapier, n8n, webhooks de formularios, GoHighLevel, HubSpot. Con `followup` activo y consentimiento, el primer SMS sale en < 1 minuto.

## 5. Despliegue automático (opcional, igual que BEXP OPS)

Clave solo para GitHub Actions, limitada a `deploy/update-all.sh`:
```bash
ssh-keygen -t ed25519 -f /root/core_actions -N "" -C "github-actions-core"
echo "command=\"/docker/automathink-core/deploy/update-all.sh\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $(cat /root/core_actions.pub)" >> /root/.ssh/authorized_keys
```
Secrets del repo: `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (contenido de `/root/core_actions`), `VPS_KNOWN_HOSTS`.

## Red de Traefik
El compose usa las mismas etiquetas que BEXP OPS (que ya funciona en este VPS). Si Traefik no ve el contenedor, añade al compose la red externa de Traefik (`docker network ls`), por ejemplo:
```yaml
    networks: [traefik]
networks:
  traefik: { external: true, name: <red-de-traefik> }
```
