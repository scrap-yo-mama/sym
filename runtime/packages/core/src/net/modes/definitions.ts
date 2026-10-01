// SPDX-License-Identifier: AGPL-3.0-only
// Proxys BYO (08 §2) et politique réseau d'une API (04 §3.2, 04b §1). Définitions saisies par l'admin seul :
// une API ne fait que choisir un proxy existant par son `id` ; une stratégie, un prompt ou un membre ne fournit
// jamais d'URL ni d'argument de proxy. Aucune I/O ici.

/** Niveaux réseau servis par le worker. `tunnel` (T) passe par l'extension (tâches 2.6, 2.7), pas par cette couche. */
export type NetworkMode = 'direct' | 'dc_proxy' | 'res_proxy';
export const NETWORK_MODES: readonly NetworkMode[] = ['direct', 'dc_proxy', 'res_proxy'];

/** `dc` = proxy serveur (N2), `res` = proxy résidentiel (N3). */
export type ProxyType = 'dc' | 'res';

export const MODE_OF_PROXY_TYPE: Readonly<Record<ProxyType, NetworkMode>> = { dc: 'dc_proxy', res: 'res_proxy' };

/** Paramètres fournisseur transmis au proxy (pays, ville, session collante), encodés dans le nom d'utilisateur. */
export type ProviderParams = { readonly country?: string; readonly city?: string; readonly session?: string };

export type ProxyPrice = {
  /** Prix par Go transféré (octets émis + reçus sur la connexion au proxy), en USD. */
  readonly perGbUsd: number;
  /** Prix par requête, en USD. */
  readonly perRequestUsd: number;
};

export type ProxyDefinition = {
  readonly id: string;
  readonly type: ProxyType;
  /** `http://`, `https://` ou `socks5://`, sans identifiants (ils sont dans le dépôt de secrets). */
  readonly url: string;
  /** Secret (dépôt 0.3a, kind `proxy`) contenant `{"username": "...", "password": "..."}`. */
  readonly credentialsSecretId?: string;
  /**
   * Gabarit du nom d'utilisateur chez le fournisseur. Jetons : `{username}` (identifiant du secret), `{country}`,
   * `{city}`, `{session}`. Un segment entre crochets n'est rendu que si tous ses jetons sont renseignés,
   * p. ex. `{username}[-country-{country}][-session-{session}]`. Absent : `{username}` seul.
   */
  readonly usernameTemplate?: string;
  readonly price: ProxyPrice;
  /**
   * Dérogation admin documentée (08b §1, classe `operator-config`) : le proxy peut résoudre vers une adresse
   * privée (proxy interne, réseau d'entreprise). Faux par défaut. Les classes dures (métadonnées cloud, 0.0.0.0,
   * multicast) restent refusées dans tous les cas.
   */
  readonly allowPrivateAddress: boolean;
};

/** Politique réseau d'une API (`apis.network_policy`). */
export type NetworkPolicy = {
  /** Niveaux autorisés. `res_proxy` n'y figure que par opt-in explicite à l'API, jamais par défaut ni par rôle. */
  readonly allow: readonly NetworkMode[];
  /** Proxy choisi par niveau, par son `id` (à défaut : le premier proxy du type, dans l'ordre de l'admin). */
  readonly proxyIds?: Readonly<Partial<Record<'dc_proxy' | 'res_proxy', string>>>;
  readonly dcProxyParams?: ProviderParams;
  readonly resProxyParams?: ProviderParams;
};

export const DEFAULT_NETWORK_POLICY: NetworkPolicy = Object.freeze({ allow: Object.freeze(['direct'] as NetworkMode[]) });

export class NetworkConfigError extends Error {
  override name = 'NetworkConfigError';
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:']);
const TEMPLATE_TOKENS = new Set(['username', 'country', 'city', 'session']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function price(input: unknown): ProxyPrice {
  const p = isRecord(input) ? input : {};
  const read = (name: string): number => {
    const v = p[name] ?? 0;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new NetworkConfigError(`prix ${name} invalide`);
    return v;
  };
  return { perGbUsd: read('per_gb_usd'), perRequestUsd: read('per_request_usd') };
}

/** Contrôle d'un gabarit : jetons connus seulement, crochets équilibrés et non imbriqués. */
export function checkUsernameTemplate(template: string): void {
  let depth = 0;
  for (const ch of template) {
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (depth < 0 || depth > 1) throw new NetworkConfigError('gabarit de nom d’utilisateur : crochets mal formés');
  }
  if (depth !== 0) throw new NetworkConfigError('gabarit de nom d’utilisateur : crochets mal formés');
  for (const match of template.matchAll(/\{([^}]*)\}/g)) {
    if (!TEMPLATE_TOKENS.has(match[1] ?? '')) throw new NetworkConfigError(`gabarit : jeton inconnu {${match[1] ?? ''}}`);
  }
  if (/[{}]/.test(template.replace(/\{[a-z]+\}/g, ''))) throw new NetworkConfigError('gabarit : accolade isolée');
  if (/[:\s]/.test(template)) throw new NetworkConfigError('gabarit : « : » et espaces interdits (séparateur Basic)');
}

/**
 * Valide une définition de proxy saisie par l'admin (forme JSON de `settings.proxies`, noms en snake_case).
 * Identifiants dans l'URL refusés : ils vont dans le dépôt de secrets, jamais en clair dans la configuration.
 */
export function parseProxyDefinition(input: unknown): ProxyDefinition {
  if (!isRecord(input)) throw new NetworkConfigError('définition de proxy invalide');
  const { id, type, url, credentials_secret_id: secretId, username_template: template } = input;
  if (typeof id !== 'string' || !ID.test(id)) throw new NetworkConfigError('id de proxy invalide');
  if (type !== 'dc' && type !== 'res') throw new NetworkConfigError(`proxy ${id} : type « dc » ou « res » attendu`);
  if (typeof url !== 'string') throw new NetworkConfigError(`proxy ${id} : url manquante`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NetworkConfigError(`proxy ${id} : url invalide`);
  }
  if (!PROXY_SCHEMES.has(parsed.protocol)) throw new NetworkConfigError(`proxy ${id} : schéma http, https ou socks5 attendu`);
  if (parsed.username !== '' || parsed.password !== '') {
    throw new NetworkConfigError(`proxy ${id} : identifiants interdits dans l’url (dépôt de secrets)`);
  }
  if ((parsed.pathname !== '' && parsed.pathname !== '/') || parsed.search !== '' || parsed.hash !== '') {
    throw new NetworkConfigError(`proxy ${id} : l’url ne doit contenir ni chemin ni paramètres`);
  }
  if (secretId !== undefined && (typeof secretId !== 'string' || secretId === '')) {
    throw new NetworkConfigError(`proxy ${id} : credentials_secret_id invalide`);
  }
  if (template !== undefined) {
    if (typeof template !== 'string' || template === '') throw new NetworkConfigError(`proxy ${id} : username_template invalide`);
    checkUsernameTemplate(template);
  }
  const allowPrivate = input.allow_private_address ?? false;
  if (typeof allowPrivate !== 'boolean') throw new NetworkConfigError(`proxy ${id} : allow_private_address booléen attendu`);
  return Object.freeze({
    id,
    type,
    url: `${parsed.protocol}//${parsed.host}`,
    ...(secretId === undefined ? {} : { credentialsSecretId: secretId }),
    ...(template === undefined ? {} : { usernameTemplate: template }),
    price: Object.freeze(price(input.price)),
    allowPrivateAddress: allowPrivate,
  });
}

export function parseProxyDefinitions(input: unknown): ProxyDefinition[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new NetworkConfigError('liste de proxys attendue');
  const out = input.map(parseProxyDefinition);
  const ids = new Set<string>();
  for (const p of out) {
    if (ids.has(p.id)) throw new NetworkConfigError(`id de proxy en double : ${p.id}`);
    ids.add(p.id);
  }
  return out;
}

const COUNTRY = /^[a-z]{2}$/;
const PARAM = /^[a-z0-9_]{1,64}$/;

/** Paramètres fournisseur : pays ISO 3166-1 alpha-2, ville et session en `[a-z0-9_]` (aucune injection de gabarit). */
export function parseProviderParams(input: unknown): ProviderParams {
  if (input === undefined || input === null) return {};
  if (!isRecord(input)) throw new NetworkConfigError('paramètres fournisseur invalides');
  const out: { country?: string; city?: string; session?: string } = {};
  for (const [key, raw] of Object.entries(input)) {
    if (key !== 'country' && key !== 'city' && key !== 'session') throw new NetworkConfigError(`paramètre fournisseur inconnu : ${key}`);
    if (typeof raw !== 'string') throw new NetworkConfigError(`paramètre ${key} : chaîne attendue`);
    const value = raw.toLowerCase();
    if (!(key === 'country' ? COUNTRY : PARAM).test(value)) throw new NetworkConfigError(`paramètre ${key} invalide`);
    out[key] = value;
  }
  return Object.freeze(out);
}

/** `apis.network_policy` (JSON, snake_case) → politique. Défaut : `direct` seul. */
export function parseNetworkPolicy(input: unknown): NetworkPolicy {
  if (input === undefined || input === null) return DEFAULT_NETWORK_POLICY;
  if (!isRecord(input)) throw new NetworkConfigError('politique réseau invalide');
  const rawAllow = input.allow ?? ['direct'];
  if (!Array.isArray(rawAllow)) throw new NetworkConfigError('network_policy.allow : liste attendue');
  const allow: NetworkMode[] = [];
  for (const mode of rawAllow) {
    // `tunnel` est servi par l'extension (2.6), ignoré ici.
    if (mode === 'tunnel') continue;
    if (!NETWORK_MODES.includes(mode as NetworkMode)) throw new NetworkConfigError(`niveau réseau inconnu : ${String(mode)}`);
    if (!allow.includes(mode as NetworkMode)) allow.push(mode as NetworkMode);
  }
  const ids = input.proxy_ids;
  const proxyIds: Partial<Record<'dc_proxy' | 'res_proxy', string>> = {};
  if (ids !== undefined) {
    if (!isRecord(ids)) throw new NetworkConfigError('network_policy.proxy_ids invalide');
    for (const [mode, id] of Object.entries(ids)) {
      if ((mode !== 'dc_proxy' && mode !== 'res_proxy') || typeof id !== 'string' || !ID.test(id)) {
        throw new NetworkConfigError('network_policy.proxy_ids invalide');
      }
      proxyIds[mode] = id;
    }
  }
  return Object.freeze({
    allow: Object.freeze(allow),
    proxyIds: Object.freeze(proxyIds),
    dcProxyParams: parseProviderParams(input.dc_proxy_params),
    resProxyParams: parseProviderParams(input.res_proxy_params),
  });
}

/**
 * Rendu du nom d'utilisateur fournisseur. Les valeurs sont déjà validées (`parseProviderParams`) ; le nom
 * d'utilisateur du secret est inséré tel quel. Un segment `[...]` disparaît si l'un de ses jetons est absent.
 */
export function renderProxyUsername(template: string | undefined, username: string, params: ProviderParams): string {
  const values: Record<string, string | undefined> = { username, ...params };
  const fill = (segment: string): string | undefined => {
    let missing = false;
    const out = segment.replace(/\{([a-z]+)\}/g, (_m, name: string) => {
      const v = values[name];
      if (v === undefined || v === '') missing = true;
      return v ?? '';
    });
    return missing ? undefined : out;
  };
  // Une seule passe par segment : une valeur insérée n'est jamais réinterprétée comme gabarit.
  let out = '';
  for (const part of (template ?? '{username}').split(/(\[[^\]]*\])/)) {
    if (part.startsWith('[') && part.endsWith(']')) {
      out += fill(part.slice(1, -1)) ?? '';
      continue;
    }
    const filled = fill(part);
    if (filled === undefined) throw new NetworkConfigError('gabarit : jeton obligatoire non renseigné (hors crochets)');
    out += filled;
  }
  return out;
}
