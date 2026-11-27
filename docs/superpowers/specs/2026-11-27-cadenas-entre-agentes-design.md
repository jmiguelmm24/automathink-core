# Cadenas entre agentes (eventos) — diseño

Fecha: 2026-11-27 · Estado: aprobado (partes 1 y 2) · Alcance: v1

## Objetivo
Que los packs (agentes) de un mismo cliente se encadenen solos: lo que hace uno dispara a otro. Todo dentro de la
instancia del cliente (no hay comunicación entre servidores). Un pack nuevo se conecta declarando a qué eventos
reacciona, sin tocar el código de los demás.

## Parte 1 — Arquitectura

**Tabla `events`** (migración `003_events.sql`): `id, type, contact_id, payload (JSON), status
(pending|done|skipped|failed), attempts, run_after, last_error, created_at, processed_at`.

**`api/events.js`**
- `emit(db, type, { contact_id, payload, run_after })`: se llama DENTRO de la transacción de la escritura que lo
  origina (como `logActivity`). Si la escritura no se guarda, el evento tampoco.
- `chainConfig(app, chainId)`: valores por defecto del `pack.json` + lo que diga `business.yaml → chains.<id>`.
- `dispatchEvents(app, now)`: lo llama `tick()` cada minuto, ANTES de los toques de seguimiento y de vaciar la
  bandeja de salida (así una reacción que programa un toque se envía en el mismo minuto).
  - Toma los eventos `pending` con `run_after` nulo o vencido (máx. 50 por vuelta).
  - Busca los packs ACTIVOS del cliente que reaccionan a ese tipo y cuya cadena está `enabled`.
  - Sin suscriptores → `skipped`.
  - El handler devuelve `{ status: 'done' | 'skipped', note? }` o `{ status: 'later', run_after }` (reacciones con
    retraso: el evento sigue pendiente hasta esa hora).
  - Si lanza un error: reintento con espera (5 min × intento); al 3.er fallo → `failed` y aviso al dueño (`error`).
  - Cada cambio de estado del evento registra una fila en `activity` en la misma transacción.

**Reacciones de un pack**
- `pack.json`:
  ```json
  "reacts_to": { "booking.created": { "handler": "onBookingCreated", "chain": "booking_to_onboarding",
                                      "defaults": { "only_new_customers": true } } }
  ```
- `packs/<id>/reactions.js` exporta los handlers: `export async function onBookingCreated(ctx, event)` con
  `ctx = { app, now, config }` (`config` = la de la cadena ya combinada). Se cargan bajo demanda y se cachean en
  `app.reactions` (los tests pueden sustituirlas).
- Regla v1: un único suscriptor por tipo de evento (los reintentos re-ejecutan el handler: debe ser idempotente).

**Configuración por cliente** (`business.yaml`, opcional): cada cadena está activa si el cliente tiene los packs.
```yaml
chains:
  booking_to_onboarding: { enabled: true, only_new_customers: true }
  cancel_to_followup:    { enabled: true, after_hours: 24 }
  hot_lead:              { enabled: true, min_score: 8, low_score_delay_hours: 24 }
```

**Eventos v1**
| Evento | Lo emite | payload |
|---|---|---|
| `booking.created` | `book_appointment` | `booking_id, service, starts_at, first_booking` |
| `booking.cancelled` | `reschedule_appointment` (cancel) | `booking_id, service, starts_at` |
| `lead.scored` | `POST /api/intake` tras clasificar | `lead_id, score, source: 'intake', consent_sms` |

Las reacciones no escriben al cliente directamente: encolan en `outbox` (respeta STOP: los contactos dados de baja
se cancelan al enviar) o ajustan lead/conversación. La bandeja guarda el mensaje en la conversación con el pack
correcto según su `kind` (`reminder → scheduler`, `onboarding → onboarding`, resto → `followup`).

## Parte 2 — Las tres cadenas

### 1. Cita → onboarding (`booking_to_onboarding`, pack `onboarding` reacciona a `booking.created`)
- Requisitos: cadena activa; `onboarding.steps` del negocio no vacío; contacto no dado de baja.
- `only_new_customers: true` (defecto): solo si `first_booking`.
- Acción: encola (`kind: 'onboarding'`) un mensaje de bienvenida con la checklist (plantilla
  `onboarding.welcome_template` del `business.yaml` o una en inglés por defecto con `{business}`, `{service}`,
  `{when}`, `{steps}`) y pone `current_pack = 'onboarding'` en su conversación para que sus respuestas las atienda
  el agente de onboarding.
- Nunca pide datos sensibles: los pasos remiten al enlace/proceso seguro del checklist.

### 2. Cancelación → seguimiento (`cancel_to_followup`, pack `followup` reacciona a `booking.cancelled`)
- Espera `after_hours` (defecto 24) desde la cancelación (`status: 'later'`).
- Pasado el plazo: `skipped` si el contacto ya tiene otra cita confirmada futura, está dado de baja o no es un
  contacto SMS (no se puede escribir proactivamente en el chat web).
- Acción: el lead pasa a `nurturing` con `interest` = servicio cancelado, `touches = 0`, `next_touch_at = now`.
  Los toques los envía el motor de seguimiento existente (`queueFollowups`).
- TCPA: solo contactos que ya conversaban con el negocio por SMS (relación existente), y STOP lo corta todo.

### 3. Lead caliente → aviso + toque (`hot_lead`, pack `followup` reacciona a `lead.scored`)
- Solo leads de formulario (`source: 'intake'`) con `consent_sms: true` y teléfono válido.
- `/api/intake` deja de programar el primer toque por su cuenta cuando la cadena está activa (si está apagada,
  se mantiene el comportamiento anterior: toque inmediato).
- `score >= min_score` (defecto 8): `next_touch_at = now` (toque en el mismo minuto) + aviso al dueño
  (`hot_lead`) si no se envió ya para ese lead.
- `score < min_score` o sin puntuación: nutrición lenta, `next_touch_at = now + low_score_delay_hours` (defecto 24).
- La respuesta de `/api/intake` mantiene `first_touch` = true cuando habrá toque programado.

## Errores y pruebas
- Reintentos y estado `failed` con aviso al dueño; nada se pierde en silencio.
- Tests con `tick(app, NOW)` y reacciones sustituibles; los eventos inmediatos no dependen del reloj real
  (`run_after` nulo).

## Fuera de alcance (v1)
Petición de reseña tras la visita, varios suscriptores por evento, eventos desde el chat (`lead.scored` de
conversaciones), integraciones externas (CRM, Google Calendar, WhatsApp).
