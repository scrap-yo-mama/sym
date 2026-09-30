// SPDX-License-Identifier: AGPL-3.0-only
// Masquage en 3 couches (INV8, 08 § 3), pour tous les puits (stdout, run_logs, error_detail, spans, métriques, artefacts) :
// (1) `Secret` se sérialise masqué ; (2) chemins explicites (redact pino, sans joker) et sérialiseurs (URL sans userinfo) ;
// (3) balayage par valeur des textes libres, à partir du registre des valeurs de secret connues du processus.
import { inspect } from 'node:util';

export const REDACTED = '[REDACTED]';
/** En dessous, une valeur n'est balayée qu'après un délimiteur (`:`, `=`, `Bearer `, `Basic `) ; les chemins explicites la couvrent aussi. */
export const MIN_SCAN_LENGTH = 6;

/** Couche 1 : valeur de secret qui ne se sérialise, ne s'affiche ni ne se journalise jamais en clair. */
export class Secret {
  readonly #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  /** Seul accès au clair : à l'endroit exact de l'usage (en-tête HTTP, URL de proxy). */
  reveal(): string {
    return this.#value;
  }
  toJSON(): string {
    return REDACTED;
  }
  toString(): string {
    return REDACTED;
  }
  [inspect.custom](): string {
    return REDACTED;
  }
}


const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Fragments base64 de `v` aux trois alignements possibles dans un flux (ex. `Basic base64(user:pass)`) : on encode
 * `v` précédé de 0, 1 ou 2 octets, puis on retire les caractères de bord qui dépendent des octets voisins inconnus.
 */
function base64Variants(v: Buffer): string[] {
  const out: string[] = [];
  for (const k of [0, 1, 2]) {
    const buf = Buffer.concat([Buffer.alloc(k), v]);
    const enc = buf.toString('base64').replace(/=+$/, '');
    const start = [0, 2, 3][k]!;
    const end = buf.length % 3 === 0 ? enc.length : enc.length - 1;
    out.push(enc.slice(start, end));
  }
  return out;
}

/** Couche 3 : valeurs de secret connues du processus (ajoutées à chaque ouverture), sous leurs encodages usuels. */
export class SecretValueRegistry {
  readonly #values = new Set<string>();
  #patterns: string[] = [];
  #short: RegExp | undefined;

  add(value: string): void {
    if (value.length === 0 || this.#values.has(value)) return;
    this.#values.add(value);
    this.#rebuild();
  }
  delete(value: string): void {
    if (this.#values.delete(value)) this.#rebuild();
  }
  clear(): void {
    this.#values.clear();
    this.#patterns = [];
    this.#short = undefined;
  }
  get size(): number {
    return this.#values.size;
  }

  #rebuild(): void {
    const variants = new Set<string>();
    const short = new Set<string>();
    for (const v of this.#values) {
      if (v.length < MIN_SCAN_LENGTH) {
        short.add(v);
        short.add(encodeURIComponent(v));
        continue;
      }
      variants.add(v);
      variants.add(JSON.stringify(v).slice(1, -1)); // forme échappée dans une ligne JSON
      variants.add(encodeURIComponent(v)); // URL (userinfo, chemin, requête)
      variants.add(new URLSearchParams({ x: v }).toString().slice(2)); // form-urlencoded (espace → +, !'()~ encodés)
      for (const b of base64Variants(Buffer.from(v))) variants.add(b); // en-tête Basic, HAR, jetons
    }
    // Les plus longues d'abord : un secret qui en contient un autre est masqué en entier.
    this.#patterns = [...variants].filter((p) => p.length >= MIN_SCAN_LENGTH).sort((a, b) => b.length - a.length);
    const alts = [...short].sort((a, b) => b.length - a.length).map(escapeRegExp);
    this.#short = alts.length
      ? new RegExp(`((?:[:=]\\s*"?)|(?:\\b(?:Bearer|Basic)\\s+))(?:${alts.join('|')})(?![A-Za-z0-9_.~%-])`, 'g')
      : undefined;
  }

  /** Remplace toute occurrence d'une valeur connue par `[REDACTED]` (valeur courte : seulement après un délimiteur). */
  redactText(text: string): string {
    let out = text;
    for (const p of this.#patterns) if (out.includes(p)) out = out.replaceAll(p, REDACTED);
    if (this.#short) out = out.replace(this.#short, `$1${REDACTED}`);
    return out;
  }
}

/** Registre du processus : `openSecret` côté dépôt y inscrit chaque valeur ouverte. */
export const secretValues = new SecretValueRegistry();

/** Nom de paramètre sensible, par sous-chaîne insensible à la casse (`x_api_key_v2`, `passphrase`, `X-Auth`…). */
const SENSITIVE_PARAM = /secret|token|key|pass|sig|auth|cred|session|cookie/i;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/**
 * Sérialiseur d'URL : userinfo retiré, valeurs des paramètres sensibles masquées, puis balayage par valeur. L'URL n'est
 * jamais re-sérialisée (remplacement de sous-chaînes) : l'encodage d'origine des autres paramètres est conservé.
 */
export function redactUrl(value: string, registry: SecretValueRegistry = secretValues): string {
  const out = value
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#\s]*@/i, '$1')
    .replace(/([?&;])([^=&#;\s]*)=([^&#;\s]*)/g, (match, sep: string, name: string) =>
      SENSITIVE_PARAM.test(safeDecode(name)) ? `${sep}${name}=${REDACTED}` : match,
    );
  return registry.redactText(out);
}

function redactError(error: Error, registry: SecretValueRegistry, seen: WeakMap<object, unknown>): Error {
  const copy = new Error(registry.redactText(error.message));
  seen.set(error, copy);
  copy.name = error.name;
  copy.stack = error.stack === undefined ? undefined : registry.redactText(error.stack);
  for (const [k, v] of Object.entries(error)) (copy as unknown as Record<string, unknown>)[k] = walk(v, registry, seen);
  if (error.cause !== undefined) copy.cause = walk(error.cause, registry, seen);
  return copy;
}

function walk(value: unknown, registry: SecretValueRegistry, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return registry.redactText(value);
  if (value instanceof Secret) return REDACTED;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof URL) return redactUrl(value.toString(), registry);
  if (value instanceof Error) return redactError(value, registry, seen);
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} octets]`;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(walk(item, registry, seen));
    return out;
  }
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value)) out[registry.redactText(k)] = walk(v, registry, seen);
  return out;
}

/**
 * Filtre générique réutilisable (traces, métriques, `run_logs`, `error_detail`, artefacts JSON) : copie profonde où
 * chaque `Secret` et chaque occurrence d'une valeur connue sont masqués ; un `Buffer` devient `[Buffer n octets]`.
 * N'altère pas l'entrée.
 */
export function redact<T>(value: T, registry: SecretValueRegistry = secretValues): T {
  return walk(value, registry, new WeakMap()) as T;
}

const SENSITIVE_HEADER = /^(?:cookie|set-cookie|authorization|proxy-authorization)$/i;

/** HAR : `cookies[].value` (requête et réponse), `postData.text`, en-têtes sensibles. */
function redactHar(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(redactHar);
  if (node === null || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'cookies' && Array.isArray(v)) {
      out[k] = v.map((c: unknown) => (c && typeof c === 'object' ? { ...c, value: REDACTED } : c));
    } else if (k === 'postData' && v && typeof v === 'object') {
      out[k] = { ...(redactHar(v) as object), ...('text' in v ? { text: REDACTED } : {}), ...('params' in v ? { params: REDACTED } : {}) };
    } else if (k === 'headers' && Array.isArray(v)) {
      out[k] = v.map((h: unknown) =>
        h && typeof h === 'object' && 'name' in h && SENSITIVE_HEADER.test(String(h.name)) ? { ...h, value: REDACTED } : redactHar(h),
      );
    } else {
      out[k] = redactHar(v);
    }
  }
  return out;
}

/** Artefact texte (HAR, trace, capture DOM) : structure HAR masquée si JSON, puis balayage par valeur. */
export function redactArtifactText(text: string, registry: SecretValueRegistry = secretValues): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return registry
      .redactText(text)
      .replace(/("name"\s*:\s*"(?:cookie|set-cookie|authorization|proxy-authorization)"\s*,\s*"value"\s*:\s*")(?:[^"\\]|\\.)*"/gi, `$1${REDACTED}"`);
  }
  return registry.redactText(JSON.stringify(redactHar(parsed)));
}

/** Couche 2 : chemins explicites (sans joker), déclinés en casse usuelle et sous les conteneurs d'en-têtes courants. */
const HEADER_NAMES = ['authorization', 'Authorization', 'cookie', 'Cookie', 'set-cookie', 'Set-Cookie', 'proxy-authorization', 'Proxy-Authorization'];
const HEADER_CONTAINERS = ['headers', 'req.headers', 'res.headers', 'request.headers', 'response.headers', 'config.headers', 'err.config.headers'];
const FIELD_NAMES = ['password', 'token', 'apiKey', 'api_key', 'secret', 'authorization', 'Authorization', 'cookie', 'Cookie'];
const FIELD_CONTAINERS = ['', 'body.', 'data.', 'proxy.', 'llm.', 'params.', 'query.'];
const pathKey = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `["${name}"]`);

export const LOG_REDACT_PATHS = [
  ...new Set([
    ...FIELD_CONTAINERS.flatMap((c) => FIELD_NAMES.map((n) => (c ? `${c.slice(0, -1)}${pathKey(n)}` : n))),
    ...HEADER_CONTAINERS.flatMap((c) => HEADER_NAMES.map((n) => `${c}${pathKey(n)}`)),
  ]),
];

type LogMethod = (...args: unknown[]) => void;

/**
 * Options pino (structurelles, sans dépendance à pino) : `redact` (chemins), `serializers` (URL, erreurs) et
 * crochets `logMethod` (balayage des arguments) et `streamWrite` (dernier filet sur la ligne JSON).
 */
export function loggerRedaction(registry: SecretValueRegistry = secretValues) {
  return {
    redact: { paths: LOG_REDACT_PATHS, censor: REDACTED },
    serializers: {
      url: (v: unknown) => (typeof v === 'string' ? redactUrl(v, registry) : redact(v, registry)),
      proxyUrl: (v: unknown) => (typeof v === 'string' ? redactUrl(v, registry) : redact(v, registry)),
    },
    hooks: {
      logMethod(this: unknown, args: unknown[], method: LogMethod): void {
        method.apply(this, args.map((a) => redact(a, registry)));
      },
      streamWrite(line: string): string {
        return registry.redactText(line);
      },
    },
  };
}
