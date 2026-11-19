// Genera las credenciales del administrador.
// Uso:  npm run hash-password -- "tu-contraseña"            → imprime las líneas para el archivo de entorno
//       npm run hash-password -- "tu-contraseña" --write    → además las guarda en él
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../api/auth.js';

const ENV_FILE = '.env';
const password = process.argv[2];
if (!password || password.startsWith('--') || password.length < 10) {
  console.error('Uso: npm run hash-password -- "contraseña de al menos 10 caracteres" [--write]');
  process.exit(1);
}
const lines = {
  ADMIN_PASSWORD_HASH: hashPassword(password),
  SESSION_SECRET: randomBytes(32).toString('hex'),
};

if (process.argv.includes('--write')) {
  let env = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : 'ADMIN_USER=admin\n';
  for (const [k, v] of Object.entries(lines)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    env = re.test(env) ? env.replace(re, `${k}=${v}`) : `${env.trimEnd()}\n${k}=${v}\n`;
  }
  writeFileSync(ENV_FILE, env);
  console.log(`Guardado en ${ENV_FILE} (ADMIN_PASSWORD_HASH y SESSION_SECRET). Revisa también ADMIN_USER.`);
} else {
  for (const [k, v] of Object.entries(lines)) console.log(`${k}=${v}`);
}
