// Démarrage de `server` (14 § 7, 13 § 4) : configuration, schéma à jour, verrou partagé des secrets, `keyCheck`
// AVANT d'écouter (MASTER_KEY différente → refus clair), puis jeton d'amorçage exigé tant qu'aucun owner n'existe.
import { initTelemetry, type Telemetry } from '@runtime/core';
import { currentSchemaVersion, createDb, expectedSchemaVersion, holdSecretsLock, keyCheck } from '@runtime/db';
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

/** Prépare le serveur sans écouter (les tests l'utilisent avec `inject`). Toute erreur arrête tout. */
export async function prepareServer(env: NodeJS.ProcessEnv = process.env, options: { logger?: boolean; loggerInstance?: FastifyBaseLogger } = {}): Promise<Started> {
  const config = loadServerConfig(env);
  // OTel : coupé par défaut (aucun module chargé) ; actif seulement si `OTEL_ENABLED=true` avec un endpoint explicite.
  const telemetry = await initTelemetry(config.observability.otel);
  const { db, pool } = createDb(config.databaseUrl, 10);
  const lockClient = new pg.Client({ connectionString: config.databaseUrl, application_name: 'runtime-server-lock' });
  // Avant que le journal existe : une erreur de connexion pendant le démarrage est levée par les appels en cours.
  pool.on('error', () => undefined);
  lockClient.on('error', () => undefined);
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    const expected = expectedSchemaVersion();
    const version = await currentSchemaVersion(pool);
    if (version !== expected) {
      throw new StartupError(`schéma de base en version ${version}, ${expected} attendue : lancez \`runtime migrate\` avant \`server\`.`);
    }
    await lockClient.connect();
    releaseLock = await holdSecretsLock(lockClient);
    const checked = await keyCheck(pool, config.keyring);
    const isInitialized = initializedProbe(pool);
    if (!(await isInitialized()) && !config.bootstrapToken) {
      throw new StartupError(
        'premier démarrage sans ADMIN_BOOTSTRAP_TOKEN : refusé. Posez ADMIN_BOOTSTRAP_TOKEN (ou _FILE, `openssl rand -base64 32`) ' +
          'pour ouvrir l’assistant /setup ; aucune route ne s’ouvre sans owner.',
      );
    }
    const auth = createAuth({
      db,
      pool,
      // Secret de la bibliothèque (signature des cookies) dérivé de MASTER_KEY par HKDF, libellé « sessions » (08 § 3).
      secret: config.keyring.current.kek('sessions').toString('base64'),
      publicUrl: config.publicUrl,
    });
    const ctx: ServerContext = {
      pool,
      auth,
      publicUrl: config.publicUrl,
      bootstrapToken: config.bootstrapToken,
      adminEmail: config.adminEmail,
      keyFingerprint: checked.fingerprint,
      expectedSchemaVersion: expected,
      keyring: config.keyring,
      metricsToken: config.metricsToken,
      metrics: createMetricsRegistry(pool),
      isInitialized,
    };
    const app = buildServer(ctx, { ...options, logLevel: config.observability.logLevel, trustProxy: config.trustProxy });
    // Une base coupée ne doit pas tuer le processus : `/api/ready` répond 503 pendant ce temps, `/api/health` reste 200.
    pool.on('error', (error) => app.log.error({ err: error }, 'pool : connexion perdue'));
    lockClient.on('error', (error) => app.log.error({ err: error }, 'verrou des secrets : connexion perdue'));
    const close = async () => {
      await app.close();
      await releaseLock?.().catch(() => undefined);
      await lockClient.end().catch(() => undefined);
      await pool.end();
      await telemetry.shutdown();
    };
    return { app, ctx, config, telemetry, close };
  } catch (error) {
    await releaseLock?.().catch(() => undefined);
    await lockClient.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await telemetry.shutdown().catch(() => undefined);
    throw error;
  }
}
