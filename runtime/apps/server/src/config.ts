// SPDX-License-Identifier: AGPL-3.0-only
// Configuration de `server` (14 § 3) : lue une fois au démarrage, variables sensibles retirées de l'environnement.
import { readFileSync } from 'node:fs';
import {
  loadKeyring,
  loadObservabilityConfig,
  parseMfaEnforced,
  scrubOtelEnvironment,
  unknownReservedVariablesWarning,
  Secret,
  secretValues,
  type Keyring,
  type MfaEnforced,
  type ObservabilityConfig,
} from '@runtime/core';
import { ssrfPolicyFromEnv, type SsrfPolicy } from '@runtime/core/net';
import { supportedLocales } from './i18n.js';

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export type ServerConfig = {
  databaseUrl: string;
  publicUrl: string;
  keyring: Keyring;
  /** Jeton de l'assistant de premier démarrage (13 § 4) ; jamais journalisé, jamais stocké. */
  bootstrapToken: Secret | null;
  /** Si posé, l'assistant n'accepte que cette adresse. */
  adminEmail: string | null;
  /** `METRICS_TOKEN` : sans jeton, `/metrics` répond 404 (fermé par défaut, 14 § 3). Jamais journalisé. */
  metricsToken: Secret | null;
  /** Journal, OTel (coupé par défaut), artefacts (niveau 0 par défaut) : 14 § 2. */
  observability: ObservabilityConfig;
  /** `RUNTIME_VERSION` (défaut 0.0.0) : version de l'application, publiée par `/api/health` (aucune autre version). */
  appVersion: string;
  port: number;
  host: string;
  /**
   * `TRUST_PROXY` (Fastify `trustProxy`) : défaut false, l’IP est celle de la connexion TCP. Derrière le proxy d’un
   * hébergeur (Render, Railway, Heroku) : `TRUST_PROXY=1` (un saut) ou la liste des IP/CIDR du proxy. Sans cela,
   * toutes les requêtes semblent venir du proxy (limites par IP communes) ; avec `true` sans proxy, un client
   * choisit son IP par X-Forwarded-For (limites contournées).
   */
  trustProxy: boolean | number | string;
  /** `MFA_ENFORCED` (13 § 7) : `off` (défaut), `admins`, `all`. */
  mfaEnforced: MfaEnforced;
  /** Garde SSRF (INV10) : relais SMTP et fournisseur OIDC en politique `operator-config` ; `ALLOWED_PRIVATE_HOSTS`. */
  ssrfPolicy: SsrfPolicy;
  /** `DEFAULT_LOCALE` (21 § 3) : langue d'instance imposée, surcharge de `settings.default_locale` ; null = non posée. */
  defaultLocale: string | null;
  /** Passerelle tunnel WSS (07 § 6, tâche 2.7). */
  tunnel: TunnelConfig;
  /** API REST (tâche 3.1, 05 § 2) : attente synchrone et file. */
  rest: RestConfig;
};

/** Bornes de l'API REST (05 § 2, 14 § 2). */
type RestConfig = {
  /** `MAX_WAIT_SECONDS` (défaut 25) : plafond du paramètre `wait` (REST, MCP). */
  maxWaitSeconds: number;
  /** `MAX_CONCURRENT_RUNS` (défaut 50, à valider) : runs actifs de l'instance au-delà desquels la création répond 429 `queue_full`. */
  maxConcurrentRuns: number;
  /** `MAX_ACTIVE_RUNS_PER_USER` (défaut 20, à valider) : runs actifs d'un utilisateur au-delà desquels la création répond 429 `user_queue_full`. */
  maxActiveRunsPerUser: number;
  /** `MAX_RUNS_PER_KEY_PER_MINUTE` (défaut 60, à valider) : créations de run par clé d'API et par minute (429 `key_rate_limited`). */
  maxRunsPerKeyPerMinute: number;
};

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) throw new ConfigError(`${name} invalide : entier de 1 à ${max}.`);
  return Number(raw);
}

type TunnelConfig = {
  /** `DISABLE_TUNNEL=true` : aucune route WSS, aucune passerelle (14 § 2). */
  disabled: boolean;
  /** `GATEWAY_INSTANCE` : identifiant de cette instance (canal NOTIFY `tunnel_cmd_<instance>`) ; défaut : hôte + pid + aléa. */
  instance: string | null;
  /**
   * Origines acceptées à l'ouverture de la WSS (en-tête Origin `chrome-extension://<id>`), jamais une origine web ni une
   * requête sans Origin. `TUNNEL_EXTENSION_IDS` : identifiants acceptés (défaut : ceux de l'extension publiée,
   * `PUBLISHED_EXTENSION_IDS`). `TUNNEL_ALLOW_ANY_EXTENSION=true` : toute extension (mode développement explicite,
   * extension décompressée) ; sinon une autre extension installée, même munie d'un jeton volé, est refusée.
   */
  extensionOrigins: ExtensionOriginPolicy;
  /** Connexion de session pour LISTEN (`DATABASE_URL_DIRECT`, défaut `DATABASE_URL`). */
  sessionUrl: string;
};

const EXTENSION_ID = /^[a-p]{32}$/;

/** Politique d'origine de la WSS du tunnel (07 § 6, 08b § 2). */
export type ExtensionOriginPolicy = { readonly ids: readonly string[]; readonly allowAny: boolean };

/**
 * Identifiants de l'extension publiée sur le Chrome Web Store, acceptés par défaut. Vide tant que l'extension n'est pas
 * publiée (tâche 2.9, soumission au Store : étape humaine) ; d'ici là, `TUNNEL_EXTENSION_IDS` (extension empaquetée par
 * l'admin) ou `TUNNEL_ALLOW_ANY_EXTENSION=true` (développement) doivent être posées, sinon aucune extension n'est acceptée.
 */
export const PUBLISHED_EXTENSION_IDS: readonly string[] = Object.freeze([]);

function loadTunnelConfig(env: NodeJS.ProcessEnv, databaseUrl: string): TunnelConfig {
  const disabled = (env['DISABLE_TUNNEL'] ?? '').trim().toLowerCase() === 'true';
  const instance = env['GATEWAY_INSTANCE']?.trim() || null;
  if (instance !== null && !/^[A-Za-z0-9_.-]{1,40}$/.test(instance)) throw new ConfigError('GATEWAY_INSTANCE invalide : 1 à 40 caractères [A-Za-z0-9_.-].');
  const listed = (env['TUNNEL_EXTENSION_IDS'] ?? '').split(',').map((v) => v.trim()).filter((v) => v !== '');
  for (const id of listed) if (!EXTENSION_ID.test(id)) throw new ConfigError(`TUNNEL_EXTENSION_IDS : identifiant d'extension invalide (${id}).`);
  const anyRaw = (env['TUNNEL_ALLOW_ANY_EXTENSION'] ?? '').trim().toLowerCase();
  if (!['', 'true', 'false'].includes(anyRaw)) throw new ConfigError('TUNNEL_ALLOW_ANY_EXTENSION invalide : true ou false (développement seulement).');
  const extensionOrigins: ExtensionOriginPolicy = { ids: listed.length > 0 ? listed : [...PUBLISHED_EXTENSION_IDS], allowAny: anyRaw === 'true' };
  return { disabled, instance, extensionOrigins, sessionUrl: env['DATABASE_URL_DIRECT'] || databaseUrl };
}

/** Version d'application publiable : SemVer ou étiquette courte (aucun espace, aucun chemin, aucun nom d'hôte). */
const APP_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

/** Longueur minimale du jeton d'amorçage (généré par la plateforme ou `install.sh`). */
const BOOTSTRAP_TOKEN_MIN_LENGTH = 32;

/**
 * Variables par lesquelles Better Auth activerait sa télémétrie malgré `telemetry.enabled: false` (lecture de
 * @better-auth/telemetry 1.7.5 : `BETTER_AUTH_TELEMETRY` l'emporte sur l'option, `_ENDPOINT` fixe la destination).
 * INV9 : retirées de l'environnement avant la création de l'instance d'auth.
 */
export const TELEMETRY_VARIABLES = ['BETTER_AUTH_TELEMETRY', 'BETTER_AUTH_TELEMETRY_ENDPOINT', 'BETTER_AUTH_TELEMETRY_DEBUG', 'BETTER_AUTH_TELEMETRY_ID'];

function readSecretVariable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  const file = env[`${name}_FILE`];
  try {
    if (direct && file) throw new ConfigError(`${name} et ${name}_FILE sont posées toutes les deux : n'en gardez qu'une.`);
    if (file) {
      try {
        return readFileSync(file, 'utf8').replace(/\s+$/, '');
      } catch (error) {
        throw new ConfigError(`${name}_FILE illisible (${file}) : ${(error as NodeJS.ErrnoException).code ?? 'erreur'}.`);
      }
    }
    return direct || undefined;
  } finally {
    delete env[name];
    delete env[`${name}_FILE`];
  }
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  const v = value?.trim() ?? '';
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v);
  if (/^[0-9a-fA-F:./, ]+$/.test(v)) return v;
  throw new ConfigError(`TRUST_PROXY invalide : true, false, un nombre de sauts ou une liste d’IP/CIDR.`);
}

export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  // Better Auth lit process.env quel que soit `env` : les deux sont nettoyés.
  const removed = TELEMETRY_VARIABLES.filter((name) => env[name] !== undefined || process.env[name] !== undefined);
  for (const target of new Set([env, process.env])) for (const name of TELEMETRY_VARIABLES) delete target[name];
  if (removed.length > 0) console.error(`Avertissement : ${removed.join(', ')} ignorée(s) : aucune télémétrie (INV9).`);

  const unknownWarning = unknownReservedVariablesWarning(env);
  if (unknownWarning) console.error(unknownWarning); // faute de frappe probable (14 § 2) : jamais fatale, jamais la valeur

  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) throw new ConfigError('DATABASE_URL manquante.');
  const publicUrl = env['PUBLIC_URL'];
  if (!publicUrl || !/^https?:\/\/[^/]+/.test(publicUrl)) {
    throw new ConfigError('PUBLIC_URL manquante ou invalide (URL http(s) de l’instance, ex. https://runtime.example.org).');
  }
  const token = readSecretVariable(env, 'ADMIN_BOOTSTRAP_TOKEN');
  if (token !== undefined && token.length < BOOTSTRAP_TOKEN_MIN_LENGTH) {
    throw new ConfigError(`ADMIN_BOOTSTRAP_TOKEN trop court (${BOOTSTRAP_TOKEN_MIN_LENGTH} caractères minimum) : générez-le avec \`openssl rand -base64 32\`.`);
  }
  if (token !== undefined) secretValues.add(token); // masquage par valeur si jamais il atteignait un journal
  const metricsToken = readSecretVariable(env, 'METRICS_TOKEN');
  if (metricsToken !== undefined && metricsToken.length < BOOTSTRAP_TOKEN_MIN_LENGTH) {
    throw new ConfigError(`METRICS_TOKEN trop court (${BOOTSTRAP_TOKEN_MIN_LENGTH} caractères minimum) : générez-le avec \`openssl rand -base64 32\`.`);
  }
  if (metricsToken !== undefined) secretValues.add(metricsToken);
  const appVersion = env['RUNTIME_VERSION'] || '0.0.0';
  if (!APP_VERSION.test(appVersion)) throw new ConfigError('RUNTIME_VERSION invalide : version SemVer (ex. 1.4.2), 64 caractères au plus, sans espace ni « / ».');
  const observability = loadObservabilityConfig(env);
  scrubOtelEnvironment(env);
  const keyring = loadKeyring(env);
  let mfaEnforced: MfaEnforced;
  try {
    mfaEnforced = parseMfaEnforced(env['MFA_ENFORCED']);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
  let ssrfPolicy: SsrfPolicy;
  try {
    ssrfPolicy = ssrfPolicyFromEnv(env);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
  const defaultLocale = env['DEFAULT_LOCALE']?.trim().toLowerCase() || null;
  if (defaultLocale !== null && !supportedLocales().includes(defaultLocale)) {
    throw new ConfigError(`DEFAULT_LOCALE invalide : « ${defaultLocale} » (langues livrées : ${supportedLocales().join(', ')}).`);
  }
  return {
    databaseUrl,
    publicUrl: new URL(publicUrl).origin,
    keyring,
    bootstrapToken: token === undefined ? null : new Secret(token),
    adminEmail: env['ADMIN_EMAIL']?.trim().toLowerCase() || null,
    metricsToken: metricsToken === undefined ? null : new Secret(metricsToken),
    observability,
    appVersion,
    port: Number(env['PORT'] ?? 3000),
    host: env['HOST'] ?? '0.0.0.0',
    trustProxy: parseTrustProxy(env['TRUST_PROXY']),
    mfaEnforced,
    ssrfPolicy,
    defaultLocale,
    tunnel: loadTunnelConfig(env, databaseUrl),
    rest: {
      maxWaitSeconds: positiveInteger(env, 'MAX_WAIT_SECONDS', 25, 25),
      maxConcurrentRuns: positiveInteger(env, 'MAX_CONCURRENT_RUNS', 50, 100_000),
      maxActiveRunsPerUser: positiveInteger(env, 'MAX_ACTIVE_RUNS_PER_USER', 20, 100_000),
      maxRunsPerKeyPerMinute: positiveInteger(env, 'MAX_RUNS_PER_KEY_PER_MINUTE', 60, 100_000),
    },
  };
}
