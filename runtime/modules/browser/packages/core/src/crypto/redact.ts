// SPDX-License-Identifier: AGPL-3.0-only
// Masquage en 3 couches (cdc/sym-browser 04d § 3.2, BINV6), schéma de SYM (runtime/packages/core/src/crypto/redact.ts) :
// (1) `Secret` se sérialise masqué ; (2) chemins explicites (redact pino) et sérialiseurs (URL sans userinfo, query `t` et
// `token` masquées, erreurs copiées) ; (3) balayage par valeur des textes libres (registre des valeurs connues du
// processus), puis, propre à SYM Browser, filtre de motifs sur la ligne finale : `Bearer …`, identifiants dans les URL,
// paramètres sensibles d'URL, préfixes de clés d'API. Les fonctions reprises de SYM rendent les mêmes sorties (vecteurs).
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
    this.#short = alts.length ? new RegExp(`((?:[:=]\\s*"?)|(?:\\b(?:Bearer|Basic)\\s+))(?:${alts.join('|')})(?![A-Za-z0-9_.~%-])`, 'g') : undefined;
  }

  /** Remplace toute occurrence d'une valeur connue par `[REDACTED]` (valeur courte : seulement après un délimiteur). */
  redactText(text: string): string {
    let out = text;
    for (const p of this.#patterns) if (out.includes(p)) out = out.replaceAll(p, REDACTED);
    if (this.#short) out = out.replace(this.#short, `$1${REDACTED}`);
    return out;
  }
}

/** Registre du processus : le dépôt des secrets y inscrit chaque valeur ouverte. */
export const secretValues = new SecretValueRegistry();

/** Nom de paramètre sensible, par sous-chaîne insensible à la casse (`x_api_key_v2`, `passphrase`, `X-Auth`…). */
const SENSITIVE_PARAM = /secret|token|key|pass|sig|auth|cred|session|cookie/i;
/** Noms exacts propres à SYM Browser : `t`, jeton de la vue en direct (04d § 1). */
const SENSITIVE_PARAM_EXACT = new Set(['t']);

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

function isSensitiveParam(rawName: string): boolean {
  const name = safeDecode(rawName);
  return SENSITIVE_PARAM_EXACT.has(name.toLowerCase()) || SENSITIVE_PARAM.test(name);
}

/**
 * Sérialiseur d'URL : userinfo retiré, valeurs des paramètres sensibles masquées, puis balayage par valeur. L'URL n'est
 * jamais re-sérialisée (remplacement de sous-chaînes) : l'encodage d'origine des autres paramètres est conservé.
 */
export function redactUrl(value: string, registry: SecretValueRegistry = secretValues): string {
  const out = value
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#\s]*@/i, '$1')
    .replace(/([?&;])([^=&#;\s]*)=([^&#;\s]*)/g, (match, sep: string, name: string) => (isSensitiveParam(name) ? `${sep}${name}=${REDACTED}` : match));
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
 * Filtre générique (événements, métriques, artefacts JSON) : copie profonde où chaque `Secret` et chaque occurrence d'une
 * valeur connue sont masqués ; un `Buffer` devient `[Buffer n octets]`. N'altère pas l'entrée.
 */
export function redact<T>(value: T, registry: SecretValueRegistry = secretValues): T {
  return walk(value, registry, new WeakMap()) as T;
}

// Audit 5.3 S17 : en-têtes d’uthentification applicatifs (X-Api-Key, X-Auth-Token, X-CSRF-Token…) masqués aussi.
const SENSITIVE_HEADER = /^(?:cookie|set-cookie|authorization|proxy-authorization)$|auth|token|secret|api[-_]?key|csrf|xsrf|session|signature|credential/i;

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
      out[k] = v.map((h: unknown) => (h && typeof h === 'object' && 'name' in h && SENSITIVE_HEADER.test(String(h.name)) ? { ...h, value: REDACTED } : redactHar(h)));
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

/** Préfixe de clé d'API (fixé par la tâche 2.1) : lettres, chiffres, `_` et `-`. */
const API_KEY_PREFIX = /^[A-Za-z0-9_-]+$/;
/** Longueur minimale après le préfixe pour qu'une suite soit une clé : en dessous, c'est le préfixe affiché (public). */
const API_KEY_MIN_TAIL = 16;

/** Couche 3, motifs : fonction compilée une fois par journal. Aucun motif n'avale `"` ni `\` : une ligne JSON reste valide. */
export function compilePatterns(apiKeyPrefixes: readonly string[] = []): (text: string) => string {
  for (const p of apiKeyPrefixes) if (!API_KEY_PREFIX.test(p)) throw new Error(`préfixe de clé d'API invalide : « ${p} »`);
  const keys = apiKeyPrefixes.length
    ? new RegExp(`(?<![A-Za-z0-9_-])(?:${apiKeyPrefixes.map(escapeRegExp).join('|')})[A-Za-z0-9_-]{${API_KEY_MIN_TAIL},}`, 'g')
    : undefined;
  return (text) => {
    let out = text
      .replace(/\b(Bearer|Basic)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)(?!\[REDACTED\]@)[^\s/?#@"'\\<>]+@/gi, `$1${REDACTED}@`)
      .replace(/([?&;])([^=&#;\s"'\\<>?]+)=([^&#;\s"'\\<>]*)/g, (match, sep: string, name: string) => (isSensitiveParam(name) ? `${sep}${name}=${REDACTED}` : match));
    if (keys) out = out.replace(keys, REDACTED);
    // Audit 5.3 S16 : secret Standard Webhooks (`whsec_…`, base64) et jeton de vue en direct (`v1.<corps>.<mac>`).
    out = out.replace(/(?<![A-Za-z0-9_-])whsec_[A-Za-z0-9+/=_-]{16,}/g, REDACTED).replace(/(?<![A-Za-z0-9_.-])v1\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, REDACTED);
    return out;
  };
}

/** Filtre de motifs seul (sans registre), pour un texte isolé. */
export function redactPatterns(text: string, apiKeyPrefixes: readonly string[] = []): string {
  return compilePatterns(apiKeyPrefixes)(text);
}

/** Couche 2 : chemins explicites, déclinés en casse usuelle et sous les conteneurs d'en-têtes courants (liste de SYM). */
const HEADER_NAMES = ['authorization', 'Authorization', 'cookie', 'Cookie', 'set-cookie', 'Set-Cookie', 'proxy-authorization', 'Proxy-Authorization'];
const HEADER_CONTAINERS = ['headers', 'req.headers', 'res.headers', 'request.headers', 'response.headers', 'config.headers', 'err.config.headers'];
const FIELD_NAMES = ['password', 'token', 'apiKey', 'api_key', 'secret', 'authorization', 'Authorization', 'cookie', 'Cookie'];
const FIELD_CONTAINERS = ['', 'body.', 'data.', 'proxy.', 'llm.', 'params.', 'query.'];
/** Chemins à un niveau de la spec 04d § 3.2 (SYM Browser) : mot de passe et jeton sous n'importe quel objet. */
const WILDCARD_PATHS = ['*.password', '*.token'];
const pathKey = (name: string) => (/^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `["${name}"]`);

export const LOG_REDACT_PATHS = [
  ...new Set([
    ...FIELD_CONTAINERS.flatMap((c) => FIELD_NAMES.map((n) => (c ? `${c.slice(0, -1)}${pathKey(n)}` : n))),
    ...HEADER_CONTAINERS.flatMap((c) => HEADER_NAMES.map((n) => `${c}${pathKey(n)}`)),
    ...WILDCARD_PATHS,
  ]),
];

export type RedactionOptions = {
  /** Préfixes des clés d'API de l'instance (tâche 2.1) : toute suite `préfixe` + 16 caractères ou plus est masquée. */
  apiKeyPrefixes?: readonly string[];
};

type LogMethod = (...args: unknown[]) => void;

/**
 * Options pino (structurelles, sans dépendance à pino) : `redact` (chemins), `serializers` (URL) et crochets `logMethod`
 * (balayage des arguments, erreurs comprises) et `streamWrite` (balayage puis motifs sur la ligne JSON finale).
 */
export function loggerRedaction(registry: SecretValueRegistry = secretValues, options: RedactionOptions = {}) {
  const patterns = compilePatterns(options.apiKeyPrefixes);
  const url = (v: unknown) => (typeof v === 'string' ? redactUrl(v, registry) : redact(v, registry));
  return {
    redact: { paths: LOG_REDACT_PATHS, censor: REDACTED },
    serializers: { url, proxyUrl: url, connectUrl: url },
    hooks: {
      logMethod(this: unknown, args: unknown[], method: LogMethod): void {
        method.apply(this, args.map((a) => redact(a, registry)));
      },
      streamWrite(line: string): string {
        return patterns(registry.redactText(line));
      },
    },
  };
}
