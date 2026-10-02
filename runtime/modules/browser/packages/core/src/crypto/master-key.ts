// SPDX-License-Identifier: AGPL-3.0-only
// MASTER_KEY (cdc/sym-browser 03 § 1, 04b § 11, BINV6) : exactement 32 octets en base64, sans phrase secrète, variantes
// _FILE et _PREVIOUS. Même schéma que SYM (runtime/packages/core/src/crypto/master-key.ts) : même sel HKDF, mêmes libellés,
// mêmes empreintes, donc mêmes vecteurs de test (vectors/sym-crypto.json). `node:crypto` seul.
import { hkdfSync, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { inspect } from 'node:util';

export const MASTER_KEY_BYTES = 32;
/** Base64 standard canonique de 32 octets : 43 caractères + un `=`. */
const BASE64_32 = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
/** Sel HKDF de SYM, repris tel quel : il fait partie du schéma et des vecteurs partagés. */
const HKDF_SALT = Buffer.from('scrapyomama-runtime/master-key/v1');

/**
 * Usages d'une KEK, un libellé HKDF par usage : `secrets` scelle tout ce qui est au repos (identifiants de proxy, profils,
 * objets), `tokens` signe les jetons de connexion et de vue (HMAC, 04 § 3 et 04d § 1). Aucune clé ne sert à deux algorithmes.
 */
export type KekPurpose = 'secrets' | 'tokens';

export class MasterKeyError extends Error {
  override name = 'MasterKeyError';
}

/** Commande de génération citée par chaque message d'erreur. */
export const KEYGEN_HINT = 'générez-en une avec `openssl rand -base64 32` (ou `pnpm --filter @sym-browser/core keygen`)';

/** Clé maîtresse en mémoire : jamais sérialisée, jamais affichée (seule son empreinte l'est). */
export class MasterKey {
  readonly #bytes: Buffer;
  readonly fingerprint: string;

  private constructor(bytes: Buffer) {
    this.#bytes = bytes;
    const fp = Buffer.from(hkdfSync('sha256', bytes, HKDF_SALT, 'fingerprint', 6)).toString('hex');
    this.fingerprint = `${fp.slice(0, 4)}-${fp.slice(4, 8)}-${fp.slice(8, 12)}`;
  }

  /** Valide strictement une valeur base64 (`name` = variable d'origine, pour le message). */
  static parse(value: string, name = 'MASTER_KEY'): MasterKey {
    if (!BASE64_32.test(value)) {
      throw new MasterKeyError(`${name} invalide : 32 octets en base64 attendus (44 caractères), pas de phrase secrète ; ${KEYGEN_HINT}.`);
    }
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== MASTER_KEY_BYTES) {
      throw new MasterKeyError(`${name} invalide : ${bytes.length} octets décodés au lieu de 32 ; ${KEYGEN_HINT}.`);
    }
    const reason = trivialReason(bytes);
    if (reason) throw new MasterKeyError(`${name} refusée : valeur triviale (${reason}) ; ${KEYGEN_HINT}.`);
    return new MasterKey(bytes);
  }

  static generate(): MasterKey {
    return new MasterKey(randomBytes(MASTER_KEY_BYTES));
  }

  /** KEK dérivée par HKDF-SHA256, un libellé par usage. */
  kek(purpose: KekPurpose): Buffer {
    return Buffer.from(hkdfSync('sha256', this.#bytes, HKDF_SALT, `kek:${purpose}`, 32));
  }

  /** Réservé à `keygen` : la seule sortie en clair, sur stdout, jamais écrite ni journalisée. */
  exportBase64(): string {
    return this.#bytes.toString('base64');
  }

  toJSON(): string {
    return `[MasterKey ${this.fingerprint}]`;
  }
  toString(): string {
    return this.toJSON();
  }
  [inspect.custom](): string {
    return this.toJSON();
  }
}

/** Valeurs triviales : octets répétés, suite régulière, texte ASCII encodé en base64 (phrase déguisée). */
function trivialReason(bytes: Buffer): string | undefined {
  if (new Set(bytes).size < 16) return 'trop peu d’octets distincts';
  const step = (bytes[1]! - bytes[0]! + 256) % 256;
  if (bytes.every((b, i) => i === 0 || (b - bytes[i - 1]! + 256) % 256 === step)) return 'suite régulière';
  if (bytes.every((b) => b >= 0x20 && b < 0x7f)) return 'texte ASCII encodé en base64, pas une clé aléatoire';
  return undefined;
}

/** Nouvelle clé en base64 (32 octets CSPRNG), pour `keygen`. */
export function generateMasterKey(): string {
  return MasterKey.generate().exportBase64();
}

export type Keyring = { current: MasterKey; previous?: MasterKey };

export type LoadKeyringOptions = {
  /** Lire aussi `MASTER_KEY_PREVIOUS` (`_FILE`) : réservé au rekey. */
  previous?: boolean;
  readFile?: (path: string) => string;
  /** Mode du fichier `_FILE` (pour l'avertissement de permissions). */
  fileMode?: (path: string) => number;
  warn?: (message: string) => void;
};

const KEY_VARIABLES = ['MASTER_KEY', 'MASTER_KEY_FILE', 'MASTER_KEY_PREVIOUS', 'MASTER_KEY_PREVIOUS_FILE'];

/** Lit `NAME` ou `NAME_FILE` (les deux posés : refus). Le contenu d'un fichier est débarrassé de ses blancs finaux. */
function readVariable(env: NodeJS.ProcessEnv, name: string, opts: Required<Omit<LoadKeyringOptions, 'previous'>>): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  if (direct !== undefined && direct !== '' && file !== undefined && file !== '') {
    throw new MasterKeyError(`${name} et ${name}_FILE sont posées toutes les deux : n'en gardez qu'une.`);
  }
  if (file !== undefined && file !== '') {
    let content: string;
    try {
      content = opts.readFile(file).replace(/\s+$/, '');
    } catch (error) {
      throw new MasterKeyError(`${name}_FILE illisible (${file}) : ${(error as NodeJS.ErrnoException).code ?? 'erreur'}.`);
    }
    try {
      const mode = opts.fileMode(file) & 0o777;
      if (mode & 0o077) opts.warn(`${name}_FILE (${file}) est lisible par le groupe ou les autres (mode ${mode.toString(8).padStart(4, '0')}) : chmod 600.`);
    } catch {
      // Mode indisponible (système de fichiers particulier) : pas d'avertissement, la lecture a réussi.
    }
    return content;
  }
  return direct === '' ? undefined : direct;
}

/**
 * Charge `MASTER_KEY` (obligatoire), variante `_FILE`, et `MASTER_KEY_PREVIOUS` seulement si `previous` (rekey).
 * Les quatre variables sont ensuite retirées de `env` (par défaut `process.env`) : aucun processus enfant (Chromium) n'en
 * hérite. Toute erreur nomme la variable et la commande de génération ; la valeur n'apparaît jamais dans un message.
 */
export function loadKeyring(env: NodeJS.ProcessEnv = process.env, options: LoadKeyringOptions = {}): Keyring {
  const opts = {
    readFile: options.readFile ?? ((p: string) => readFileSync(p, 'utf8')),
    fileMode: options.fileMode ?? ((p: string) => statSync(p).mode),
    warn: options.warn ?? ((m: string) => process.stderr.write(`Avertissement : ${m}\n`)),
  };
  try {
    const current = readVariable(env, 'MASTER_KEY', opts);
    if (current === undefined) throw new MasterKeyError(`MASTER_KEY manquante (ou MASTER_KEY_FILE) : ${KEYGEN_HINT}.`);
    const keyring: Keyring = { current: MasterKey.parse(current, 'MASTER_KEY') };
    if (options.previous) {
      const previous = readVariable(env, 'MASTER_KEY_PREVIOUS', opts);
      if (previous !== undefined) keyring.previous = MasterKey.parse(previous, 'MASTER_KEY_PREVIOUS');
    }
    return keyring;
  } finally {
    for (const name of KEY_VARIABLES) delete env[name];
  }
}
