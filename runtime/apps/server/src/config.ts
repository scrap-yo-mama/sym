// Configuration de `server` (14 § 3) : lue une fois au démarrage, variables sensibles retirées de l'environnement.
import { readFileSync } from 'node:fs';
import { loadKeyring, Secret, secretValues, type Keyring } from '@runtime/core';

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
  port: number;
  host: string;
  /**
   * `TRUST_PROXY` (Fastify `trustProxy`) : défaut false, l’IP est celle de la connexion TCP. Derrière le proxy d’un
   * hébergeur (Render, Railway, Heroku) : `TRUST_PROXY=1` (un saut) ou la liste des IP/CIDR du proxy. Sans cela,
   * toutes les requêtes semblent venir du proxy (limites par IP communes) ; avec `true` sans proxy, un client
   * choisit son IP par X-Forwarded-For (limites contournées).
   */
  trustProxy: boolean | number | string;
};

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
  const keyring = loadKeyring(env);
  return {
    databaseUrl,
    publicUrl: new URL(publicUrl).origin,
    keyring,
    bootstrapToken: token === undefined ? null : new Secret(token),
    adminEmail: env['ADMIN_EMAIL']?.trim().toLowerCase() || null,
    port: Number(env['PORT'] ?? 3000),
    host: env['HOST'] ?? '0.0.0.0',
    trustProxy: parseTrustProxy(env['TRUST_PROXY']),
  };
}
