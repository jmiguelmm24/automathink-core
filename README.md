# Automathink Core

Agentes de IA **plug and play** para pymes: un **orquestador** que decide quién atiende cada mensaje y **agentes ejecutores** (packs) que se activan por cliente. Una instancia aislada por cliente en el VPS (su base de datos, sus claves, su subdominio). Nace de BEXP OPS: reutiliza su base de datos, login, cifrado, orquestador por niveles de modelo y despliegue Docker + Traefik.

```
SMS (Twilio) ─┐                       ┌─ reception   Chatbot / recepción        save_lead, handoff
Chat web ─────┼─► ORQUESTADOR ────────┼─ scheduler   Agenda + recordatorios     check_availability, book, reschedule
Formularios ──┘   · STOP / humano     ├─ followup    Seguimiento de leads       toques día 0-1-3-7 + reservas
 (/api/intake)    · palabras clave    ├─ onboarding  Onboarding de clientes     update_onboarding
                  · continuidad       ├─ backoffice  Clasifica y puntúa leads   save_lead (sin hablar al cliente)
                  · Haiku si duda     └─ reports     Informe semanal "horas ahorradas" al dueño
                  · Haiku / Sonnet
                          │
              avisos al dueño (SMS / webhook) · panel del cliente · informe de impacto
```

## Probar en 1 minuto

```bash
npm install
npm run demo          # Sonrisa Dental Miami (cliente ficticio de demo)
```
- Panel: http://127.0.0.1:3000 (usuario `demo`, contraseña en la consola)
- Chat: http://127.0.0.1:3000/chat.html
- Sin `ANTHROPIC_API_KEY` usa un motor de prueba gratis (respuestas fijas). Con la clave en `.env`, Claude de verdad.
- Hablar con el agente desde la terminal: `CLIENT_DIR=./clients/demo-dental npm run chat`

## Qué es cada cosa

| Carpeta | Qué hay |
|---|---|
| `api/orquestador.js` | Enrutado de mensajes al pack y elección de modelo (Haiku por defecto, Sonnet en mensajes delicados, tope mensual de tokens) |
| `api/engine.js` | Bucle del agente con herramientas (máx. 6 vueltas), aviso de IA en el primer mensaje, STOP/START, pasar a humano |
| `api/tools/` | Herramientas: agenda (horario + citas sin solapes, zona horaria del negocio), leads, onboarding, pasar a humano |
| `api/scheduler.js` | Cada minuto: recordatorios 24 h antes, toques de seguimiento, bandeja de salida, informe del lunes |
| `api/reports.js` | Informe de impacto: conversaciones, fuera de horario, citas, leads, horas y $ ahorrados (estimación), coste de IA |
| `packs/<id>/` | `pack.json` (nombre comercial, precio del deck, herramientas, palabras clave) + `prompt.md` |
| `clients/_template/` | `business.yaml`: el perfil del negocio. **Lo único que cambia entre clientes** |
| `clients/demo-dental/` | Cliente ficticio para las demos |
| `deploy/` | Alta de cliente (`new-client.sh`), actualizar todos (`update-all.sh`), copias (`backup-all.sh`), guía del VPS |
| `web/` | Panel del cliente (impacto, conversaciones con "tomar el control", citas, leads, avisos) y chat web |

## Vender un pack nuevo

1. `packs/<id>/pack.json` + `prompt.md` (copiar uno parecido).
2. Si necesita una herramienta nueva: añadirla en `api/tools/index.js` y listarla en el `pack.json`.
3. Test en `test/` → `npm run check && npm test`.
4. Activarlo en el `business.yaml` del cliente (`packs: [...]`) y `docker compose restart`.
5. Si debe reaccionar a lo que hacen otros packs (cita creada, cancelada, lead puntuado…): `reacts_to` en su `pack.json` + `packs/<id>/reactions.js`. Ver [cadenas entre agentes](docs/superpowers/specs/2026-11-27-cadenas-entre-agentes-design.md).

## Alta de un cliente (VPS)

```bash
sudo /docker/automathink-core/deploy/new-client.sh sonrisa-dental sonrisa.automathink.io "reception,scheduler,reports"
```
Detalle en [deploy/VPS.md](deploy/VPS.md).

## Canales y cumplimiento

- **SMS (EE. UU.)**: Twilio, webhook `POST /webhooks/twilio/sms` con firma verificada. STOP/UNSUBSCRIBE → baja inmediata (TCPA). El número del cliente necesita **A2P 10DLC** aprobado.
- **Formularios → back-office**: `POST /api/intake` con cabecera `x-intake-token`. Solo hay toques por SMS si llega `consent_sms: true`.
- **Aviso de IA** en la primera respuesta de cada conversación (`assistant.disclosure`). Obligatorio en la UE (AI Act art. 50).
- **Acotado al negocio**: el agente rechaza peticiones generales (política de WhatsApp 2026 y buena práctica).
- WhatsApp Cloud API: siguiente canal (España/LATAM). Google Calendar: siguiente integración de agenda.
