// SPDX-License-Identifier: AGPL-3.0-only
// Archive d'un profil persistant (cdc/sym-browser 04c § 4.1, tâche 3.1) : tar (ustar, en-tête PAX pour les chemins longs)
// compressé en gzip, des seules bases d'état du répertoire de profil Chromium (cookies, Local et Session Storage,
// IndexedDB, préférences, bases de service workers). Les caches HTTP, de code et GPU, les verrous et les journaux sont
// reconstruits à chaque session. Le chiffrement est celui de l'ObjectStore (enveloppe, AAD tenantId|profileId|version).
//
// Écrit ici plutôt qu'avec une dépendance (`tar`, `tar-stream`) : seul un sous-ensemble est utile (fichiers réguliers),
// et la restauration doit être stricte : ni lien, ni type spécial, ni chemin hors de la sélection ou du répertoire cible,
// taille décompressée plafonnée (archive piégée).
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

export class ProfileArchiveError extends Error {
  override name = 'ProfileArchiveError';
}

export class ProfileTooLargeError extends Error {
  override name = 'ProfileTooLargeError';
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super(`profil au-delà de la taille maximale (${maxBytes} octets)`);
    this.maxBytes = maxBytes;
  }
}

/** Répertoire de profil Chromium dans le répertoire de données (`Default`, `Profile 1`…). */
const PROFILE_DIR = /^(Default|Profile [0-9]{1,4})$/;
/** Fichiers isolés du profil conservés. */
const PROFILE_FILES = new Set(['Preferences', 'Secure Preferences', 'Cookies', 'Cookies-journal']);
/** Arborescences du profil conservées entières (chemins relatifs au profil). */
const PROFILE_TREES = ['Local Storage', 'Session Storage', 'IndexedDB', 'WebStorage', 'Service Worker/Database', 'Service Worker/ScriptCache'];
/** Dans `Network`, seules les bases d'état. */
const NETWORK_FILES = /^(Cookies|Cookies-journal|TransportSecurity|Trust Tokens|Trust Tokens-journal)$/;
/** Racine du répertoire de données : seul `Local State` est conservé. */
const ROOT_FILES = new Set(['Local State']);

const SAFE_COMPONENT = /^[^\0/\\]+$/;

function components(path: string): string[] | undefined {
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || !SAFE_COMPONENT.test(p))) return undefined;
  return parts;
}

/** Vrai si le chemin (relatif au répertoire de données, séparateur `/`) appartient à l'archive d'un profil. */
export function isPersistedProfilePath(path: string): boolean {
  const parts = components(path);
  if (!parts) return false;
  if (parts.length === 1) return ROOT_FILES.has(parts[0]!);
  if (!PROFILE_DIR.test(parts[0]!)) return false;
  const inner = parts.slice(1);
  if (inner.length === 1) return PROFILE_FILES.has(inner[0]!);
  if (inner[0] === 'Network') return inner.length === 2 && NETWORK_FILES.test(inner[1]!);
  const rel = inner.join('/');
  return PROFILE_TREES.some((tree) => rel.startsWith(`${tree}/`));
}

/** Vrai si le répertoire `path` peut contenir une entrée conservée (descente de l'archivage). */
function mayContainPersisted(path: string): boolean {
  const parts = components(path);
  if (!parts || !PROFILE_DIR.test(parts[0]!)) return false;
  const rel = parts.slice(1).join('/');
  return rel === '' || rel === 'Network' || rel === 'Service Worker' || PROFILE_TREES.some((tree) => rel === tree || rel.startsWith(`${tree}/`));
}

type Entry = { rel: string; abs: string; size: number };

async function selectFiles(root: string): Promise<Entry[]> {
  const out: Entry[] = [];
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && dir === root) return;
      throw error;
    }
    for (const name of names.sort()) {
      const abs = join(dir, name);
      const rel = relative(root, abs).split(sep).join('/');
      const stat = await lstat(abs);
      if (stat.isDirectory()) {
        // Descente seulement là où une entrée conservée peut se trouver.
        if (mayContainPersisted(rel)) await walk(abs);
      } else if (stat.isFile() && isPersistedProfilePath(rel)) {
        out.push({ rel, abs, size: stat.size });
      }
      // Liens symboliques, sockets, tubes : jamais archivés.
    }
  };
  await walk(root);
  return out;
}

const BLOCK = 512;

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

function header(name: string, size: number, type: '0' | 'x'): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(0o600, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(0, 12), 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}

const padding = (size: number) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);

/** Enregistrement PAX `path` (longueur décimale incluse dans elle-même). */
function paxPath(path: string): Buffer {
  const body = ` path=${path}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(`${len}${body}`) !== len) len += 1;
  return Buffer.from(`${len}${body}`);
}

async function* tarStream(entries: Entry[], maxBytes: number): AsyncGenerator<Buffer> {
  let total = 0;
  for (const entry of entries) {
    if (Buffer.byteLength(entry.rel) > 100) {
      const pax = paxPath(entry.rel);
      yield header('PaxHeader', pax.length, 'x');
      yield Buffer.concat([pax, padding(pax.length)]);
    }
    yield header(Buffer.byteLength(entry.rel) > 100 ? 'long-path' : entry.rel, entry.size, '0');
    // Taille figée à la sélection : un fichier qui change pendant l'archivage la rendrait incohérente.
    let read = 0;
    const chunks = entry.size === 0 ? [] : createReadStream(entry.abs, { end: entry.size - 1 });
    for await (const chunk of chunks) {
      const buf = chunk as Buffer;
      read += buf.length;
      total += buf.length;
      if (total > maxBytes) throw new ProfileTooLargeError(maxBytes);
      yield buf;
    }
    if (read !== entry.size) throw new ProfileArchiveError(`fichier modifié pendant l’archivage : ${entry.rel}`);
    yield padding(entry.size);
  }
  yield Buffer.alloc(BLOCK * 2);
}

export type PackedProfile = { files: number; bytes: number; stream: AsyncIterable<Buffer> };

/**
 * Archive (tar + gzip) les bases d'état du répertoire de données `root`. La taille (somme des fichiers retenus) est
 * vérifiée AVANT tout octet produit : `ProfileTooLargeError` au-delà de `maxBytes`.
 */
export async function packProfile(root: string, opts: { maxBytes: number }): Promise<PackedProfile> {
  const entries = await selectFiles(root);
  const bytes = entries.reduce((sum, e) => sum + e.size, 0);
  if (bytes > opts.maxBytes) throw new ProfileTooLargeError(opts.maxBytes);
  const gzip = createGzip();
  const stream = Readable.from(tarStream(entries, opts.maxBytes));
  pipeline(stream, gzip).catch((error: unknown) => gzip.destroy(error as Error));
  return { files: entries.length, bytes, stream: gzip };
}

function field(h: Buffer, offset: number, length: number): string {
  const raw = h.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}

function parseOctal(h: Buffer, offset: number, length: number): number {
  const text = field(h, offset, length).trim();
  if (!/^[0-7]{1,11}$/.test(text)) throw new ProfileArchiveError('en-tête tar invalide (nombre)');
  return parseInt(text, 8);
}

function checkHeader(h: Buffer): void {
  const expected = parseOctal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
  if (sum !== expected) throw new ProfileArchiveError('en-tête tar invalide (somme de contrôle)');
}

function parsePax(body: Buffer): string | undefined {
  let path: string | undefined;
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const digits = space === -1 ? '' : body.subarray(offset, space).toString('latin1');
    const len = /^[1-9][0-9]{0,5}$/.test(digits) ? Number(digits) : NaN;
    if (!Number.isSafeInteger(len) || offset + len > body.length || body[offset + len - 1] !== 0x0a) throw new ProfileArchiveError('en-tête PAX invalide');
    const record = body.subarray(space + 1, offset + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq <= 0) throw new ProfileArchiveError('en-tête PAX invalide');
    if (record.slice(0, eq) === 'path') path = record.slice(eq + 1);
    offset += len;
  }
  return path;
}

/** Lecteur d'octets exacts sur un flux. */
class ByteReader {
  readonly #it: AsyncIterator<Buffer>;
  #buf: Buffer = Buffer.alloc(0);
  constructor(source: AsyncIterable<Buffer>) {
    this.#it = source[Symbol.asyncIterator]();
  }
  async read(n: number): Promise<Buffer> {
    while (this.#buf.length < n) {
      const r = await this.#it.next();
      if (r.done) throw new ProfileArchiveError('archive de profil tronquée');
      this.#buf = this.#buf.length === 0 ? r.value : Buffer.concat([this.#buf, r.value]);
    }
    const out = this.#buf.subarray(0, n);
    this.#buf = this.#buf.subarray(n);
    return out;
  }
  /** Consomme la fin du flux (bourrage après la marque de fin), au plus `limit` octets, tous nuls. */
  async drain(limit: number): Promise<void> {
    let seen = this.#buf.length;
    if (this.#buf.some((b) => b !== 0)) throw new ProfileArchiveError('données après la fin de l’archive');
    this.#buf = Buffer.alloc(0);
    for (let r = await this.#it.next(); !r.done; r = await this.#it.next()) {
      seen += r.value.length;
      if (seen > limit || r.value.some((b: number) => b !== 0)) throw new ProfileArchiveError('données après la fin de l’archive');
    }
  }
  /** Lit `n` octets par morceaux (sans tout garder en mémoire). */
  async *chunks(n: number): AsyncGenerator<Buffer> {
    let left = n;
    while (left > 0) {
      if (this.#buf.length === 0) {
        const r = await this.#it.next();
        if (r.done) throw new ProfileArchiveError('archive de profil tronquée');
        this.#buf = r.value;
      }
      const take = Math.min(left, this.#buf.length);
      yield this.#buf.subarray(0, take);
      this.#buf = this.#buf.subarray(take);
      left -= take;
    }
  }
}

/**
 * Restaure une archive (gzip) dans `dest` (répertoire de données de la session, existant). Refuse tout ce qui n'est pas
 * un fichier régulier de la sélection (`ProfileArchiveError`) et toute archive qui dépasse `maxBytes` une fois
 * décompressée (`ProfileTooLargeError`). Fichiers 0600, répertoires 0700.
 */
export async function unpackProfile(source: AsyncIterable<Buffer | Uint8Array>, dest: string, opts: { maxBytes: number }): Promise<{ files: number; bytes: number }> {
  const gunzip = createGunzip();
  const input = Readable.from(source);
  const piping = pipeline(input, gunzip);
  piping.catch(() => undefined);
  const reader = new ByteReader(gunzip as AsyncIterable<Buffer>);
  let files = 0;
  let bytes = 0;
  let pendingPath: string | undefined;
  try {
    for (;;) {
      const h = await reader.read(BLOCK);
      if (h.every((b) => b === 0)) {
        await reader.drain(64 * BLOCK);
        break;
      }
      checkHeader(h);
      const size = parseOctal(h, 124, 12);
      const type = String.fromCharCode(h[156] ?? 0);
      if (type === 'x') {
        if (size > 64 * 1024) throw new ProfileArchiveError('en-tête PAX trop grand');
        pendingPath = parsePax(await reader.read(size));
        await reader.read(padding(size).length);
        continue;
      }
      if (type !== '0' && type !== '\0') throw new ProfileArchiveError(`type d’entrée refusé (${JSON.stringify(type)})`);
      const prefix = field(h, 345, 155);
      const name = pendingPath ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
      pendingPath = undefined;
      const parts = components(name);
      if (!parts || !isPersistedProfilePath(name)) throw new ProfileArchiveError('chemin refusé dans l’archive de profil');
      bytes += size;
      if (bytes > opts.maxBytes) throw new ProfileTooLargeError(opts.maxBytes);
      const target = join(dest, ...parts);
      if (!target.startsWith(dest + sep)) throw new ProfileArchiveError('chemin hors du répertoire de profil');
      await mkdir(join(dest, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
      const file = await open(target, 'wx', 0o600);
      try {
        for await (const chunk of reader.chunks(size)) await file.write(chunk);
      } finally {
        await file.close();
      }
      await reader.read(padding(size).length);
      files += 1;
    }
    await piping;
  } finally {
    input.destroy();
    gunzip.destroy();
  }
  return { files, bytes };
}
