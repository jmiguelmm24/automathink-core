// Automathink Core — canal SMS (Twilio). En EE. UU. el SMS es el canal principal.
// Requisitos legales que este código respeta:
//  - TCPA: STOP / UNSUBSCRIBE / CANCEL / END / QUIT → baja inmediata (contacts.opted_out) y nunca más se escribe.
//  - Registro A2P 10DLC del número en Twilio: es un trámite fuera del código (ver deploy/CLIENT_SETUP.md).
import { createHmac, timingSafeEqual } from 'node:crypto';

export const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|baja|parar)\s*$/i;
export const START_WORDS = /^\s*(start|unstop|yes)\s*$/i;

// Envía un SMS. Sin credenciales (local / demo) no envía nada: devuelve { simulated: true }.
export async function sendSms(config, to, body, { fetchImpl = fetch } = {}) {
  const { sid, token, from } = config.twilio;
  if (!sid || !token || !from) return { simulated: true };
  const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return { sid: j.sid };
}

// Firma de Twilio: HMAC-SHA1 (base64) de la URL completa + parámetros POST ordenados (clave+valor concatenados)
export function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

export function validTwilioSignature(authToken, url, params, header) {
  if (!authToken || !header) return false;
  const a = Buffer.from(twilioSignature(authToken, url, params)), b = Buffer.from(String(header));
  return a.length === b.length && timingSafeEqual(a, b);
}
