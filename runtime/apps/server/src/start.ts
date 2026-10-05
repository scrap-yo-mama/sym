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
import { initTelemetry, kekFor, MIN_EXTENSION_VERSION, type JobQueue, type Telemetry } from '@runtime/core';
import { SsrfGuard } from '@runtime/core/net';
import {
  alertQueueDefinition,
  currentSchemaVersion,
  createDb,
  expectedSchemaVersion,
  holdSecretsLock,
  KeyCheckError,
  keyCheck,
  persistenceQueueDefinition,
  siteSessionCheckQueueDefinition,
  PgBossJobQueue,
  runQueueDefinition,
  scheduledRunQueueDefinition,
  schemaVersionRefusal,
  secretStore,
  webhookDeliveryQueueDefinition,
  type NegativeMemory,
} from '@runtime/db';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildServer } from './app.js';
import { createMcpRuntime, type McpListenTuning } from './mcp/runtime.js';
import { createAuth } from './auth/better-auth.js';
import { readSecuritySettings } from './auth/security-settings.js';
import { loadServerConfig, type ServerConfig } from './config.js';
import { initializedProbe, type ServerContext } from './context.js';
import { createMetricsRegistry } from './metrics.js';
import { TunnelGateway } from './tunnel/gateway.js';

class StartupError extends Error {
  override name = 'StartupError';
}

export type Started = { app: FastifyInstance; ctx: ServerContext; config: ServerConfig; telemetry: Telemetry; close: () => Promise<void> };

export type PrepareOptions = {
  logger?: boolean;
  loggerInstance?: FastifyBaseLogger;
  /** Période de relecture de la version du schéma en mode dégradé (défaut 5 s). Les sondes la relisent aussi. */
  schemaPollMs?: number;
  /** Version minimale d'extension (défaut : `MIN_EXTENSION_VERSION` de @runtime/core). Les tests la relèvent. */
  minExtension?: string;
  /** Erreur fatale pendant l'initialisation différée (défaut : journalisée ; index.ts arrête le processus). */
  onFatal?: (error: Error) => void;
  /** Autorités supplémentaires du relais SMTP et de l'IdP (certificats privés) : tests. */
  extraCa?: string[];
  /** Tests seulement : accepte un IdP OIDC en http (faux fournisseur local). */
  oidcAllowHttp?: boolean;
  /** Tests seulement : garde SSRF du serveur (fixtures sur la boucle locale, résolveur injecté) ; défaut : la politique de l'environnement. */
  guard?: SsrfGuard;
  /** Passerelle tunnel : périodes de sondage, de revalidation et délai d'inactivité (tests ; défauts de production). */
  tunnel?: { pollMs?: number; revalidateMs?: number; idleMs?: number };
  /** API REST : relecture des attentes et du flux SSE, ping, plafond de flux (tests ; défauts de production). */
  rest?: { pollMs?: number; pingMs?: number; maxStreamsPerUser?: number; revalidateMs?: number; progressHeartbeatMs?: number };
  /** Serveur MCP : relecture et plafonds des flux subscriptions/listen (tests ; défauts de production). */
  mcp?: McpListenTuning;
  /** Statut « modèle validé » : autre fichier que eval/validated-models.json (tests). */
  validatedModelsFile?: URL | string;
  /** Mode « SYM ne lâche pas » : mémoire négative (2.12) ; tests seulement tant que le port n'est pas branché (volet prior_refusal, 4.2). */
  persistence?: { negativeMemory?: NegativeMemory };
};

/** Files que le `server` alimente (runs, planifications, livraisons de webhooks, alertes) : créées si elles manquent. */
const SERVER_QUEUES = () => [runQueueDefinition(), scheduledRunQueueDefinition(), webhookDeliveryQueueDefinition(), alertQueueDefinition(), persistenceQueueDefinition(), siteSessionCheckQueueDefinition()];

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
      settings: () => readSecuritySettings(pool),
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
      ctx.secretsKek = kekFor(config.keyring.current, checked.version, 'secrets');
      ctx.secrets = secretStore(pool, config.keyring, checked);
      ctx.keyChecked = checked;
    };

    // File pg-boss (3.1) : démarrée au premier usage, sur la connexion de session (DATABASE_URL_DIRECT), sans supervision.
    const queue = new PgBossJobQueue({
      connectionString: config.tunnel.sessionUrl,
      max: 2,
      supervise: false,
      application_name: 'runtime-server-queue',
      onError: (error) => holder.app?.log.error({ err: error }, 'file : erreur pg-boss'),
    });
    let queueReady: Promise<JobQueue> | undefined;
    const jobs = (): Promise<JobQueue> => {
      queueReady ??= (async () => {
        await queue.start();
        for (const definition of SERVER_QUEUES()) await queue.createQueue(definition, { keepExisting: true });
        return queue as JobQueue;
      })().catch((error: unknown) => {
        queueReady = undefined;
        throw error;
      });
      return queueReady;
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
      appCommit: config.appCommit,
      minExtension: options.minExtension ?? MIN_EXTENSION_VERSION,
      startup: { ready: tryFinish },
      expectedSchemaVersion: expected,
      keyring: config.keyring,
      metricsToken: config.metricsToken,
      metrics: createMetricsRegistry(pool),
      // Posée par finishInit (version de clé connue après keyCheck) ; jamais lue avant : tant que le démarrage n'est pas terminé, seules les sondes répondent.
      siteSessionKek: kekFor(config.keyring.current, 0, 'site_sessions'),
      isInitialized,
      mfaEnforced: config.mfaEnforced,
      defaultLocaleEnv: config.defaultLocale,
      guard: options.guard ?? new SsrfGuard({ policy: config.ssrfPolicy }),
      secretsKek: kekFor(config.keyring.current, 0, 'secrets'),
      secrets: null,
      keyChecked: null,
      jobs,
      rest: {
        maxWaitSeconds: config.rest.maxWaitSeconds,
        maxConcurrentRuns: config.rest.maxConcurrentRuns,
        pollMs: options.rest?.pollMs ?? 500,
        pingMs: options.rest?.pingMs ?? 15_000,
        maxStreamsPerUser: options.rest?.maxStreamsPerUser ?? 5,
        revalidateMs: options.rest?.revalidateMs ?? 30_000,
        ...(options.rest?.progressHeartbeatMs === undefined ? {} : { progressHeartbeatMs: options.rest.progressHeartbeatMs }),
        maxActiveRunsPerUser: config.rest.maxActiveRunsPerUser,
        maxRunsPerKeyPerMinute: config.rest.maxRunsPerKeyPerMinute,
        userBudgetDailyUsd: config.rest.userBudgetDailyUsd,
        maxCostUsdPerRun: config.rest.maxCostUsdPerRun,
      },
      mcp: config.mcp.disabled ? null : createMcpRuntime(pool, config.mcp, options.mcp),
      ...(config.brief === undefined ? {} : { brief: config.brief }),
      confirmAboveUsd: config.confirmAboveUsd,
      persistence: { policy: config.persistence, ...(options.persistence?.negativeMemory === undefined ? {} : { negativeMemory: options.persistence.negativeMemory }) },
      ...(options.extraCa ? { extraCa: options.extraCa } : {}),
      ...(options.oidcAllowHttp ? { oidcAllowHttp: true } : {}),
      ...(options.validatedModelsFile === undefined ? {} : { validatedModelsFile: options.validatedModelsFile }),
      // Passerelle tunnel WSS (07 § 6) : LISTEN sur le canal de cette instance, démarrée avant l'écoute HTTP.
      tunnel: config.tunnel.disabled
        ? null
        : new TunnelGateway({
            pool,
            sessionUrl: config.tunnel.sessionUrl,
            instance: config.tunnel.instance,
            logger: () => holder.app!.log,
            ...options.tunnel,
          }),
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
      tunnelOrigins: config.tunnel.extensionOrigins,
    });
    holder.app = app;
    if (!config.tunnel.disabled && config.tunnel.extensionOrigins.ids.length === 0 && !config.tunnel.extensionOrigins.allowAny) {
      app.log.warn('tunnel : aucune extension acceptée (extension pas encore publiée) : posez TUNNEL_EXTENSION_IDS, ou TUNNEL_ALLOW_ANY_EXTENSION=true en développement');
    }
    await ctx.tunnel?.start();
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
      await ctx.tunnel?.close();
      await app.close();
      if (queueReady) await queueReady.then((q) => q.stop({ timeoutMs: 2000 })).catch(() => undefined);
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
