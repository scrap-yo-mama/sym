// SPDX-License-Identifier: AGPL-3.0-only
// Démarrage de `server` (14 § 7, 13 § 4) : configuration, schéma à jour, verrou partagé des secrets, `keyCheck`
// AVANT d'écouter (MASTER_KEY différente → refus clair), puis jeton d'amorçage exigé tant qu'aucun owner n'existe.
import { kekFor } from '@runtime/core';
import { currentSchemaVersion, createDb, expectedSchemaVersion, holdSecretsLock, keyCheck } from '@runtime/db';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildServer } from './app.js';
import { createAuth } from './auth/better-auth.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { initializedProbe, type ServerContext } from './context.js';

class StartupError extends Error {
  override name = 'StartupError';
}

export type Started = { app: FastifyInstance; ctx: ServerContext; config: ServerConfig; close: () => Promise<void> };

/** Prépare le serveur sans écouter (les tests l'utilisent avec `inject`). Toute erreur arrête tout. */
export async function prepareServer(env: NodeJS.ProcessEnv = process.env, options: { logger?: boolean } = {}): Promise<Started> {
  const config = loadServerConfig(env);
  const { db, pool } = createDb(config.databaseUrl, 10);
  const lockClient = new pg.Client({ connectionString: config.databaseUrl, application_name: 'runtime-server-lock' });
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
      siteSessionKek: kekFor(config.keyring.current, checked.version, 'site_sessions'),
      isInitialized,
    };
    const app = buildServer(ctx, { ...options, trustProxy: config.trustProxy });
    const close = async () => {
      await app.close();
      await releaseLock?.().catch(() => undefined);
      await lockClient.end().catch(() => undefined);
      await pool.end();
    };
    return { app, ctx, config, close };
  } catch (error) {
    await releaseLock?.().catch(() => undefined);
    await lockClient.end().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }
}
