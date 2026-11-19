# Automathink Core — instrucciones para Claude

Producto de Automathink (Jose Miguel + socio developer): agentes de IA por cliente. Lee `README.md`.

## Reglas
- Backend: Node ≥ 22.9, ESM, Fastify 5, better-sqlite3. Esquema = nueva migración `api/migrations/NNN_nombre.sql` (nunca editar una aplicada).
- Frontend `web/`: HTML + JS puro, sin build. Paleta Automathink en `web/brand.css` (antracita `#1F2421`, verde salvia `#9CC5A1` solo sobre oscuro, perla `#DCE1DE`).
- Comentarios y docs internos en español; lo que ve el cliente final (panel, chat, mensajes) en inglés por defecto (mercado EE. UU.), el agente responde en el idioma del cliente.
- **Cada escritura registra una fila en `activity` en la misma transacción** (`logActivity`).
- **Nada específico de un cliente en el código**: todo va en `clients/<cliente>/business.yaml` o en su `.env`.
- Un pack solo puede usar las herramientas de su `pack.json` (el motor lo comprueba).
- Respetar siempre: STOP/opt-out, aviso de IA, consentimiento SMS en `/api/intake`, nunca pedir datos de tarjeta/SSN.
- Secretos solo en `.env`. Rutas nuevas bajo `/api/` quedan protegidas por `api/auth.js` salvo que se añadan a `PUBLIC` a propósito.

## Antes de cada commit
```bash
npm run check && npm test
```
