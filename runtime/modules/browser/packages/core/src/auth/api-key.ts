// SPDX-License-Identifier: AGPL-3.0-only
// Format des secrets présentés à la passerelle (cdc/sym-browser 04f § 3 : « type reconnu à son préfixe », fixé par 2.1) :
//   clé d'API          symb_<identifiant 12 car. [A-Za-z0-9]>_<secret 32 octets base64url, 43 car.>
//   jeton de connexion symt_<charge base64url><HMAC base64url, 43 car.>   (connect-token.ts)
// Le préfixe affiché (`symb_` + identifiant) est public : il sert à retrouver la ligne (`api_keys.key_prefix`, unique) et à
// reconnaître la clé dans la console ; seule l'empreinte argon2id du tout est stockée. Les deux formats sont des suites
// [A-Za-z0-9_-] : le filtre de motifs des journaux (0.3) masque toute suite `symb_`/`symt_` de 16 caractères ou plus.
import { randomBytes, randomInt } from 'node:crypto';
import { Secret } from '../crypto/redact.js';

export const API_KEY_PREFIX = 'symb_';
export const CONNECT_TOKEN_PREFIX = 'symt_';
/** Préfixes à passer au masquage des journaux (`loggerRedaction({ apiKeyPrefixes })`, `compilePatterns`). */
export const CREDENTIAL_PREFIXES = [API_KEY_PREFIX, CONNECT_TOKEN_PREFIX] as const;

const ID_LENGTH = 12;
const SECRET_BYTES = 32;
const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const API_KEY = /^(symb_[A-Za-z0-9]{12})_[A-Za-z0-9_-]{43}$/;

/** Clé neuve (CSPRNG). La clé n'existe en clair que dans le `Secret` rendu : affichée une fois, jamais stockée. */
export function generateApiKey(): { key: Secret; prefix: string } {
  let id = '';
  for (let i = 0; i < ID_LENGTH; i++) id += ALPHANUM[randomInt(ALPHANUM.length)];
  const prefix = `${API_KEY_PREFIX}${id}`;
  return { key: new Secret(`${prefix}_${randomBytes(SECRET_BYTES).toString('base64url')}`), prefix };
}

/** Préfixe affiché d'une clé bien formée, `null` sinon (aucune autre forme n'est une clé). */
export function apiKeyPrefixOf(value: string): string | null {
  return API_KEY.exec(value)?.[1] ?? null;
}

/** Forme tronquée pour un journal ou un message : préfixe affiché d'une clé, 4 caractères d'un jeton, rien d'autre. */
export function truncateCredential(value: string): string {
  const prefix = apiKeyPrefixOf(value);
  if (prefix) return `${prefix}…`;
  if (value.startsWith(CONNECT_TOKEN_PREFIX) && value.length > CONNECT_TOKEN_PREFIX.length + 4) return `${value.slice(0, CONNECT_TOKEN_PREFIX.length + 4)}…`;
  return '…';
}
