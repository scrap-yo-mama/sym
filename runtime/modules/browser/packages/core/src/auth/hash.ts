// SPDX-License-Identifier: AGPL-3.0-only
// Empreinte argon2id (RFC 9106) par `node:crypto` (crypto.argon2, Node 24.7+) : aucune dépendance native. Format PHC
// `$argon2id$v=19$m=…,t=…,p=…$<sel>$<empreinte>` (base64 sans remplissage), lisible par les autres implémentations.
// Paramètres : recommandation OWASP (m = 19 Mio, t = 2, p = 1). Les paramètres lus dans une empreinte sont bornés : une
// ligne altérée ne peut pas faire consommer 4 Gio à la passerelle. Comparaison à temps constant (timingSafeEqual).
import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';

export const ARGON2ID_PARAMS = Object.freeze({ memory: 19_456, passes: 2, parallelism: 1, tagLength: 32, saltLength: 16 });

const MAX_MEMORY_KIB = 262_144; // 256 Mio
const MAX_PASSES = 10;
const MAX_PARALLELISM = 8;
const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,2}),p=(\d{1,2})\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/;

type Params = { memory: number; passes: number; parallelism: number };

function derive(secret: string, salt: Buffer, params: Params): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      'argon2id',
      { message: Buffer.from(secret, 'utf8'), nonce: salt, parallelism: params.parallelism, tagLength: ARGON2ID_PARAMS.tagLength, memory: params.memory, passes: params.passes },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');

export async function hashSecret(secret: string): Promise<string> {
  const { memory, passes, parallelism, saltLength } = ARGON2ID_PARAMS;
  const salt = randomBytes(saltLength);
  const tag = await derive(secret, salt, { memory, passes, parallelism });
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${b64(salt)}$${b64(tag)}`;
}

/** `true` si `secret` correspond à l'empreinte ; empreinte malformée ou hors bornes : `false`, sans exception. */
export async function verifySecret(secret: string, phc: string): Promise<boolean> {
  const match = PHC.exec(phc);
  if (!match) return false;
  const params = { memory: Number(match[1]), passes: Number(match[2]), parallelism: Number(match[3]) };
  if (params.parallelism < 1 || params.parallelism > MAX_PARALLELISM) return false;
  if (params.passes < 1 || params.passes > MAX_PASSES) return false;
  if (params.memory < 8 * params.parallelism || params.memory > MAX_MEMORY_KIB) return false;
  const salt = Buffer.from(match[4]!, 'base64');
  const expected = Buffer.from(match[5]!, 'base64');
  // Base64 non canonique (bits de bord) : refusé, une empreinte n'a qu'une écriture.
  if (b64(salt) !== match[4] || b64(expected) !== match[5]) return false;
  const actual = await derive(secret, salt, params);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;

/** Vérification à blanc, au coût d'une vraie : un préfixe inconnu répond dans le même temps qu'un secret faux. */
export async function burnVerification(): Promise<void> {
  dummy ??= hashSecret(randomBytes(32).toString('base64url'));
  await verifySecret('x', await dummy);
}
