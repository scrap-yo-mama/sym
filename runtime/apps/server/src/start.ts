// SPDX-License-Identifier: AGPL-3.0-only
// Démarrage de `server` (14 § 5 et § 7, 13 § 4) : configuration, verrou partagé des secrets, puis, schéma à jour,
// `keyCheck` (MASTER_KEY différente → refus clair) et jeton d'amorçage exigé tant qu'aucun owner n'existe.
//
// Schéma EN RETARD (base vierge, ou image N déployée avant `runtime migrate`) : démarrage en MODE DÉGRADÉ. Seules
// `/api/health` (200) et `/api/ready` (503, `schema: false`) répondent ; toute autre route répond 503. La version du schéma
// est relue à chaque sonde et toutes les `schemaPollMs` ; dès qu'elle est à jour, l'initialisation se termine sans
// redémarrage (`/api/ready` passe de 503 à 200, recette 1). Schéma PLUS RÉCENT que le code : refus de démarrer (garde
// contre un retour d'image sans restauration). Une erreur fatale pendant l'initialisation différée (clé, amorçage) est
// remise à `onFatal` (index.ts : message clair puis sortie 1).
import { initTelemetry, kekFor, type Telemetry } from '@runtime/core';
import { currentSchemaVersion, createDb, expectedSchemaVersion, holdSecretsLock, KeyCheckError, keyCheck, schemaVersionRefusal } from '@runtime/db';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildServer } from './app.js';
import { createAuth } from './auth/better-auth.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { initializedProbe, type ServerContext } from './context.js';
import { createMetricsRegistry } from './metrics.js';

class StartupError extends Error {
  override name = 'StartupError';
}

export type Started = { app: FastifyInstance; ctx: ServerContext; config: ServerConfig; telemetry: Telemetry; close: () => Promise<void> };

export type PrepareOptions = {
  logger?: boolean;
  loggerInstance?: FastifyBaseLogger;
  /** Période de relecture de la version du schéma en mode dégradé (défaut 5 s). Les sondes la relisent aussi. */
  schemaPollMs?: number;
  /** Erreur fatale pendant l'initialisation différée (défaut : journalisée ; index.ts arrête le processus). */
  onFatal?: (error: Error) => void;
};

const BOOTSTRAP_REQUIRED =
  'premier démarrage sans ADMIN_BOOTSTRAP_TOKEN : refusé. Posez ADMIN_BOOTSTRAP_TOKEN (ou _FILE, `openssl rand -base64 32`) ' +
  'pour ouvrir l’assistant /setup ; aucune route ne s’ouvre sans owner.';

/** Schéma plus récent que le code : même texte que le `worker` (schemaVersionRefusal, 14 § 5-6). */
const newerSchema = (version: number, expected: number) =>
  new StartupError(schemaVersionRefusal(version, expected, 'server') ?? `schéma de base en version ${version} : refus de démarrer.`);

/** Erreurs qui ne se corrigent pas en attendant : mauvaise clé, amorçage impossible, schéma trop récent. */
const isFatal = (error: unknown) => error instanceof StartupError || error instanceof KeyCheckError;

/** Prépare le serveur sans écouter (les tests l'utilisent avec `inject`). Toute erreur avant le retour arrête tout. */
export async function prepareServer(env: NodeJS.ProcessEnv = process.env, options: PrepareOptions = {}): Promise<Started> {
  const config = loadServerConfig(env);
  // OTel : coupé par défaut (aucun module chargé) ; actif seulement si `OTEL_ENABLED=true` avec un endpoint explicite.
  const telemetry = await initTelemetry(config.observability.otel);
  const { db, pool } = createDb(config.databaseUrl, 10);
  const lockClient = new pg.Client({ connectionString: config.databaseUrl, application_name: 'runtime-server-lock' });
  // Avant que le journal existe : une erreur de connexion pendant le démarrage est levée par les appels en cours.
  pool.on('error', () => undefined);
  lockClient.on('error', () => undefined);
  let releaseLock: (() => Promise<void>) | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    const expected = expectedSchemaVersion();
    const version = await currentSchemaVersion(pool);
    if (version > expected) throw newerSchema(version, expected);
    // Base vierge : aucun owner ne peut exister, le jeton d'amorçage est donc exigé tout de suite.
    if (version === 0 && !config.bootstrapToken) throw new StartupError(BOOTSTRAP_REQUIRED);
    await lockClient.connect();
    releaseLock = await holdSecretsLock(lockClient);
    const isInitialized = initializedProbe(pool);
    const auth = createAuth({
      db,
      pool,
      // Secret de la bibliothèque (signature des cookies) dérivé de MASTER_KEY par HKDF, libellé « sessions » (08 § 3).
      secret: config.keyring.current.kek('sessions').toString('base64'),
      publicUrl: config.publicUrl,
    });

    /** Fin de l'initialisation, sur un schéma à jour : keyCheck (écrit `key_check` au premier démarrage), amorçage. */
    const finishInit = async (): Promise<void> => {
      const checked = await keyCheck(pool, config.keyring);
      if (!(await isInitialized()) && !config.bootstrapToken) throw new StartupError(BOOTSTRAP_REQUIRED);
      ctx.keyFingerprint = checked.fingerprint;
      ctx.siteSessionKek = kekFor(config.keyring.current, checked.version, 'site_sessions');
    };

    let state: 'waiting' | 'ready' | 'failed' = 'waiting';
    let pending: Promise<boolean> | undefined;
    const holder: { app?: FastifyInstance } = {};
    const fatal = (error: Error) => {
      state = 'failed';
      if (timer) clearInterval(timer);
      if (options.onFatal) options.onFatal(error);
      else holder.app?.log.error({ err: error }, 'démarrage refusé');
    };
    /** Relit la version du schéma et termine l'initialisation dès qu'elle est à jour. Un seul essai à la fois. */
    const tryFinish = (): Promise<boolean> => {
      if (state !== 'waiting') return Promise.resolve(state === 'ready');
      pending ??= (async () => {
        try {
          const now = await currentSchemaVersion(pool);
          if (now > expected) throw newerSchema(now, expected);
          if (now < expected) return false;
          await finishInit();
          state = 'ready';
          if (timer) clearInterval(timer);
          holder.app?.log.info({ schema: now }, 'schéma à jour : initialisation terminée');
          return true;
        } catch (error) {
          if (isFatal(error)) fatal(error as Error);
          return false; // base momentanément injoignable : nouvel essai à la prochaine sonde
        } finally {
          pending = undefined;
        }
      })();
      return pending;
    };

    const ctx: ServerContext = {
      pool,
      auth,
      publicUrl: config.publicUrl,
      bootstrapToken: config.bootstrapToken,
      adminEmail: config.adminEmail,
      keyFingerprint: '',
      appVersion: config.appVersion,
      startup: { ready: tryFinish },
      expectedSchemaVersion: expected,
      keyring: config.keyring,
      metricsToken: config.metricsToken,
      metrics: createMetricsRegistry(pool),
      // Posée par finishInit (version de clé connue après keyCheck) ; jamais lue avant : tant que le démarrage n'est pas terminé, seules les sondes répondent.
      siteSessionKek: kekFor(config.keyring.current, 0, 'site_sessions'),
      isInitialized,
    };
    if (version === expected) {
      // Cas nominal : toute erreur d'initialisation empêche de démarrer (comportement inchangé).
      await finishInit();
      state = 'ready';
    }
    const app = buildServer(ctx, {
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.loggerInstance === undefined ? {} : { loggerInstance: options.loggerInstance }),
      logLevel: config.observability.logLevel,
      trustProxy: config.trustProxy,
    });
    holder.app = app;
    if (state === 'waiting') {
      app.log.warn({ schema: version, expected }, 'schéma de base en retard : mode dégradé (seules les sondes répondent) jusqu’à `runtime migrate`');
      timer = setInterval(() => void tryFinish(), options.schemaPollMs ?? 5000);
      timer.unref();
    }
    // Une base coupée ne doit pas tuer le processus : `/api/ready` répond 503 pendant ce temps, `/api/health` reste 200.
    pool.on('error', (error) => app.log.error({ err: error }, 'pool : connexion perdue'));
    lockClient.on('error', (error) => app.log.error({ err: error }, 'verrou des secrets : connexion perdue'));
    const close = async () => {
      if (timer) clearInterval(timer);
      await app.close();
      await pending?.catch(() => undefined);
      await releaseLock?.().catch(() => undefined);
      await lockClient.end().catch(() => undefined);
      await pool.end();
      await telemetry.shutdown();
    };
    return { app, ctx, config, telemetry, close };
  } catch (error) {
    if (timer) clearInterval(timer);
    await releaseLock?.().catch(() => undefined);
    await lockClient.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await telemetry.shutdown().catch(() => undefined);
    throw error;
  }
}
