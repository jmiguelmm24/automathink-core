// Automathink Core — cifrado de credenciales (AES-256-GCM)
// La clave maestra sale de MASTER_KEY (64 caracteres hex) o, si no existe, de un archivo
// master.key junto a la base de datos (se crea solo, permisos 600). Sin esa clave, las
// credenciales guardadas en la base de datos son ilegibles.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function loadMasterKey({ envKey = process.env.MASTER_KEY, dbPath = './data/core.sqlite' } = {}) {
  if (envKey) {
    const key = Buffer.from(envKey, 'hex');
    if (key.length !== 32) throw new Error('MASTER_KEY debe tener 64 caracteres hexadecimales');
    return key;
  }
  if (dbPath === ':memory:') return randomBytes(32); // tests
  const file = join(dirname(dbPath), 'master.key');
  if (existsSync(file)) return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex');
  mkdirSync(dirname(file), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

// Formato: v1.<iv>.<tag>.<datos>  (base64url)
export function encrypt(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function decrypt(key, text) {
  const [v, iv, tag, data] = String(text).split('.');
  if (v !== 'v1') throw new Error('Formato de credencial desconocido');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8'));
}

// Para mostrar una credencial sin revelarla: ••••1234
export const mask = s => (s ? `••••${String(s).slice(-4)}` : '');
