// SPDX-License-Identifier: AGPL-3.0-only
// Assemblage des rôles au démarrage (cdc/sym-browser 03 § 4, 04b § 5, § 6, § 9 et § 11, 04d § 3.3 ; tâche 5.1). L'image n'a
// qu'un point d'entrée (apps/gateway/dist/main.js) ; `SYMB_MODE` choisit ce qui tourne :
//   - passerelle (`gateway`, `all`) : migrations sous verrou consultatif puis première clé (`SYMB_BOOTSTRAP_API_KEY`), en
//     tâche de fond réessayée (la base peut arriver après le service) ; balayeur des nœuds muets ; `/readyz` : base,
//     migrations à jour, au moins un nœud `ready` ;
//   - nœud (`node`, `all`) : pool de Chromium chauds derrière le proxy de lancement fermé, battement dans `nodes` dès que
//     le service écoute ; `/readyz` : base, migrations à jour (appliquées par la passerelle : ordre de démarrage
//     indifférent), battement écrit, Chromium lancé et capacité libre.
// Drainage (SIGTERM) : le nœud passe `draining`, puis `drainSessions` (point d'accroche de la tâche 2.7 : sessions finies
// raison `node_shutdown` avant l'échéance), puis battement arrêté, Chromium fermés et `down`.
// Mode `all` (F-20261002-01, R1 de l'audit 5.3) : API REST `/v1` (2.2), relais WSS public (2.3) et relais interne du nœud,
// superviseur et hôte des sessions (1.2, 1.7), egress par session imposé au Chromium dedicated (1.5, BINV2), montés sur le
// port du service (sessions.ts). L'API est montée une fois les migrations appliquées (`/readyz` : vérification `api`) ;
// ses URL de connexion reprennent l'hôte de la demande (api/public-url.ts). Modes séparés : seuls la santé, les migrations,
// le battement et le pool sont assemblés ; `POST /internal/sessions` (04b § 12) reste à servir (journal, F-20261002-03).
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  ApiKeyAuthenticator,
  bootstrapApiKeyRecord,
  CAPACITY,
  ConnectTokens,
  createBrowserMetrics,
  MasterKey,
  MetricsRegistry,
  type BrowserConfig,
  type HttpMount,
  type Logger,
  type PreparedRole,
  type ReadinessCheck,
} from '@sym-browser/core';
import { currentSchemaVersion, ensureFirstApiKey, expectedSchemaVersion, markNodeState, migrateUp, pgApiKeyStore, readyNodeExists, recordHeartbeat, sweepLostNodes } from '@sym-browser/db';
import {
  BrowserPool,
  installedPlaywrightVersion,
  nodePoolOptions,
  OwnedProcessGroups,
  playwrightLauncher,
  startClosedLaunchProxy,
  startHeartbeat,
  type BrowserLauncher,
  type ClosedLaunchProxy,
} from '@sym-browser/node';
import { dedicatedLauncher } from '@sym-browser/node/dedicated';
import type { SessionEgress } from '@sym-browser/node/egress';
import { BROWSER_ENGINE } from '@sym/contracts/browser';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { createGatewayApi } from '../api/index.js';
import { publicUrlFromRequest } from '../api/public-url.js';
import { assembleAllModeSessions, type AllModeSessions } from './sessions.js';

export type RuntimeDeps = {
  log: Logger;
  /** Lanceur de Chromium ; défaut : Playwright derrière le proxy de lancement fermé (tests : lanceur factice). */
  launcher?: BrowserLauncher;
  /**
   * Lanceur des Chromium dedicated pour une URL de proxy de lancement (l'egress de LA session, BINV2) ; défaut :
   * `dedicatedLauncher` (tâche 1.4) sur `SYMB_DATA_DIR`. Tests : lanceur factice qui retient l'URL reçue.
   */
  dedicatedLauncher?: (launchProxyUrl: string) => BrowserLauncher;
  /** Reprise des tâches de démarrage (migrations, sonde Chromium) : délai initial doublé jusqu'au plafond. */
  retry?: { initialMs: number; maxMs: number };
  /** Période du balayeur des nœuds muets (04b § 6 : 5 s). */
  sweepIntervalMs?: number;
  /** Tâche 2.7 : terminer les sessions locales avant `deadline` (raison `node_shutdown`). Défaut : aucune session tenue. */
  drainSessions?: (input: { deadline: Date; nodeId: string }) => Promise<void>;
  appVersion?: string;
};

const DEFAULT_RETRY = { initialMs: 1000, maxMs: 30_000 };

export async function prepareRuntime(config: BrowserConfig, deps: RuntimeDeps): Promise<PreparedRole> {
  const { log } = deps;
  const runsGateway = config.mode !== 'node';
  const runsNode = config.mode !== 'gateway';
  const retry = deps.retry ?? DEFAULT_RETRY;
  const expected = expectedSchemaVersion();
  const cleanups: Array<() => Promise<void> | void> = [];
  let stopped = false;
  let startupDone = false;
  let markMigrated!: () => void;
  const migrated = new Promise<void>((resolve) => (markMigrated = resolve));
  let api: FastifyInstance | undefined;
  let sessions: AllModeSessions | undefined;
  let listeningPort = config.port;
  // Mode all : les compteurs de la passerelle (sessions, file, nœuds) vont dans le registre servi par /metrics.
  const observability = config.mode === 'all' ? (() => {
    const registry = new MetricsRegistry();
    return { registry, metrics: createBrowserMetrics(registry, 'all') };
  })() : undefined;

  const db = new pg.Pool({ connectionString: config.databaseUrl.reveal(), max: 5, application_name: `sym-browser-${config.mode}`, connectionTimeoutMillis: 5000 });
  // Une connexion inactive coupée par le serveur ne doit pas faire tomber le process ; le message peut contenir l'URL.
  db.on('error', () => log('warn', 'database_connection_lost', {}));

  /** Tâche de démarrage réessayée jusqu'au succès (ou à l'arrêt). Seul le nom de l'erreur est journalisé. */
  const retrying = (name: string, task: () => Promise<void>): Promise<void> =>
    (async () => {
      let delay = retry.initialMs;
      while (!stopped) {
        try {
          await task();
          return;
        } catch (error) {
          log('warn', 'startup_retry', { task: name, error: (error as Error).name, code: (error as { code?: string }).code, retryInMs: delay });
          await new Promise((resolve) => setTimeout(resolve, delay).unref());
          delay = Math.min(delay * 2, retry.maxMs);
        }
      }
    })();

  const checks: ReadinessCheck[] = [
    {
      name: 'database',
      run: async () => {
        try {
          await db.query('SELECT 1');
          return 'ok';
        } catch {
          return 'injoignable';
        }
      },
    },
    {
      name: 'schema',
      run: async () => {
        try {
          const version = await currentSchemaVersion(db);
          if (version !== expected) return version < expected ? 'en attente' : 'version inconnue';
          // Passerelle : prête seulement après sa tâche de démarrage (première clé comprise), sinon un client qui attend
          // /readyz 200 pourrait recevoir 401 avec la clé d'échange.
          return runsGateway && !startupDone ? 'en attente' : 'ok';
        } catch {
          return 'injoignable';
        }
      },
    },
  ];
  const onDrain: Array<() => Promise<void>> = [];
  let onListening: ((port: number) => void) | undefined;

  if (runsGateway) {
    void retrying('migrations', async () => {
      const { applied } = await migrateUp({ connectionString: config.databaseUrl.reveal() });
      if (applied.length > 0) log('info', 'migrated', { applied });
      if (config.bootstrapApiKey) {
        const result = await ensureFirstApiKey(db, await bootstrapApiKeyRecord(config.bootstrapApiKey));
        log('info', 'bootstrap_api_key', { result });
      }
      startupDone = true;
      markMigrated();
    });
    const sweeper = setInterval(() => {
      void sweepLostNodes(db).then(
        ({ nodes }) => nodes.length > 0 && log('warn', 'nodes_lost', { nodes }),
        () => undefined,
      );
    }, deps.sweepIntervalMs ?? 5000);
    sweeper.unref();
    cleanups.push(() => clearInterval(sweeper));
    // Tâche 2.7 : fermer ici les relais WSS (code 1012) ; les sessions continuent sur les nœuds.
    onDrain.push(async () => clearInterval(sweeper));
    checks.push({
      name: 'nodes',
      run: async () => {
        try {
          return (await readyNodeExists(db, null)) ? 'ok' : 'aucun nœud prêt';
        } catch {
          return 'injoignable';
        }
      },
    });
  }

  if (runsNode) {
    let proxy: ClosedLaunchProxy | undefined;
    let launch = deps.launcher;
    let sweep: (() => unknown) | undefined;
    const groups = new OwnedProcessGroups();
    if (!launch) {
      proxy = await startClosedLaunchProxy();
      launch = playwrightLauncher({ launchProxyUrl: proxy.url, groups });
      sweep = () => groups.sweep();
    }
    const launcher = launch;
    // Egress de chaque session tenue (mode all) : le Chromium dedicated est lancé sur celui de SA session, jamais sans.
    const egresses = new Map<string, SessionEgress>();
    const dedicatedFor = deps.dedicatedLauncher ?? ((launchProxyUrl: string) => dedicatedLauncher({ dataDir: config.dataDir, launchProxyUrl, groups, removeSessionDir: false }));
    const launchDedicated: BrowserLauncher = (purpose) => {
      const egress = purpose.sessionId === undefined ? undefined : egresses.get(purpose.sessionId);
      if (!egress) return Promise.reject(new Error('session dedicated sans egress de session'));
      return dedicatedFor(egress.url)(purpose);
    };
    const { options, capacity } = nodePoolOptions(config.node, {
      launch: launcher,
      ...(config.mode === 'all' ? { launchDedicated } : {}),
      ...(sweep ? { sweep } : {}),
      onEvent: (event) => log(event.kind === 'launch_failed' ? 'warn' : 'debug', 'pool', { ...event }),
    });
    const browsers = new BrowserPool(options);
    if (config.mode === 'all') {
      sessions = await assembleAllModeSessions({ config, db, pool: browsers, egresses, log });
      cleanups.push(() => sessions?.close());
    }
    let chromium: 'en attente' | 'ok' | 'échec du lancement' = 'en attente';

    /** Chromium lançable : un Chromium chaud existe, ou une sonde (lancer puis fermer) réussit. */
    const probe = async (): Promise<void> => {
      if (browsers.stats().browsers.warm > 0) return;
      const launched = await launcher({ role: 'warm' });
      await launched.close();
    };
    void browsers
      .start()
      .then(probe)
      .then(
        () => void (chromium = 'ok'),
        () => {
          chromium = 'échec du lancement';
          log('error', 'chromium_launch_failed', {});
          void retrying('chromium', async () => {
            await probe();
            chromium = 'ok';
          });
        },
      );

    const nodeId = config.node.id;
    let url = config.node.publicUrl;
    let lastBeat = 0;
    let nodeState: 'ready' | 'draining' = 'ready';
    let beatFailing = false;
    let heartbeat: { stop: () => void } | undefined;
    const beat = async (): Promise<{ recovered: boolean }> => {
      const stats = browsers.stats();
      const result = await recordHeartbeat(db, {
        nodeId,
        url,
        region: config.node.region,
        playwrightVersion: installedPlaywrightVersion(),
        chromiumVersion: BROWSER_ENGINE.chromium,
        appVersion: deps.appVersion ?? '0.0.0',
        // Unités de slot (0.6, 2.4) : l'admission réserve `sessionUnits(type)` sur `slots_free`.
        slotsTotal: stats.slotsTotal * CAPACITY.SLOT_UNITS,
        slotsFree: chromium === 'ok' ? Math.floor(stats.slotsFreeExact * CAPACITY.SLOT_UNITS) : 0,
        rssBytes: process.memoryUsage().rss,
        limitBytes: capacity.limitBytes,
      });
      lastBeat = Date.now();
      nodeState = result.state;
      if (beatFailing) log('info', 'heartbeat_restored', { nodeId });
      beatFailing = false;
      return result;
    };
    onListening = (port) => {
      listeningPort = port;
      if (config.mode === 'all') url = `http://127.0.0.1:${port}`;
      heartbeat = startHeartbeat({
        beat,
        // Nœud isolé (04b § 6) : sessions locales détruites sans écriture d'état (mode all ; modes séparés : aucune tenue).
        isolate: async () => sessions?.isolate(),
        intervalMs: config.node.heartbeatMs,
        onError: (error) => {
          if (!beatFailing) log('warn', 'heartbeat_failed', { nodeId, error: (error as Error).name, code: (error as { code?: string }).code });
          beatFailing = true;
        },
      });
    };
    checks.push(
      {
        name: 'heartbeat',
        run: () => {
          if (lastBeat === 0) return 'en attente';
          if (Date.now() - lastBeat > 3 * config.node.heartbeatMs) return 'en retard';
          return nodeState === 'draining' ? 'draining' : 'ok';
        },
      },
      {
        name: 'chromium',
        run: () => (chromium !== 'ok' ? chromium : browsers.stats().slotsFree > 0 ? 'ok' : 'complet'),
      },
    );

    let poolClosed = false;
    const closePool = async (): Promise<void> => {
      if (poolClosed) return;
      poolClosed = true;
      await browsers.close();
      await proxy?.close();
    };
    onDrain.push(async () => {
      await markNodeState(db, { nodeId, state: 'draining' }).catch(() => log('warn', 'drain_state_failed', { nodeId }));
      const deadline = new Date(Date.now() + config.shutdownGraceSeconds * 1000);
      await sessions?.drain(deadline).catch(() => log('warn', 'drain_sessions_failed', { nodeId }));
      await deps.drainSessions?.({ deadline, nodeId });
      heartbeat?.stop();
      await closePool();
      await markNodeState(db, { nodeId, state: 'down' }).catch(() => log('warn', 'drain_state_failed', { nodeId }));
      log('info', 'node_down', { nodeId });
      // Relais encore ouverts : fermés en 1012 (redémarrage du service) une fois les sessions terminées.
      await api?.close().catch(() => undefined);
    });
    cleanups.push(
      () => heartbeat?.stop(),
      () => closePool(),
    );
  }

  let http: HttpMount | undefined;
  if (config.mode === 'all' && sessions) {
    const local = sessions;
    const tokens = new ConnectTokens({
      current: MasterKey.parse(config.masterKey.reveal(), 'MASTER_KEY'),
      ...(config.masterKeyPrevious ? { previous: MasterKey.parse(config.masterKeyPrevious.reveal(), 'MASTER_KEY_PREVIOUS') } : {}),
    });
    void retrying('api', async () => {
      await migrated;
      if (api || stopped) return;
      const app = await createGatewayApi({
        db,
        auth: new ApiKeyAuthenticator(pgApiKeyStore(db)),
        tokens,
        launcher: local.launcher,
        publicUrl: (request) => publicUrlFromRequest(request, () => `http://127.0.0.1:${listeningPort}`),
        queueTimeoutMs: config.queue.timeoutMs,
        queue: { queueMax: config.queue.max, queueMaxPerTenant: config.queue.maxPerTenant },
        relay: { nodeToken: local.nodeToken, ...(config.limits.cdpMaxMessageBytes > 0 ? { cdpMaxMessageBytes: config.limits.cdpMaxMessageBytes } : {}) },
        ...(observability ? { observability: { ...observability, token: config.metricsToken } } : {}),
        onError: (error) => log('error', 'api_error', { error: (error as Error).name, code: (error as { code?: string }).code, ref: randomUUID() }),
      });
      await app.ready();
      await local.replayUsage().catch(() => log('warn', 'usage_wal_replay_failed', {}));
      if (stopped) return void (await app.close());
      api = app;
      log('info', 'api_mounted', {});
    });
    cleanups.unshift(() => api?.close());
    checks.push({ name: 'api', run: () => (api ? 'ok' : 'en attente') });
    const starting = (response: ServerResponse): void => {
      response.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'retry-after': '1', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ error: { code: 'service_starting', message: 'Service starting.', retryable: true } }));
    };
    http = {
      request: (request, response) => {
        if (local.handleRequest(request, response)) return;
        if (!api) return starting(response);
        api.routing(request, response);
      },
      upgrade: (request, socket, head) => {
        if (local.handleUpgrade(request, socket, head)) return;
        if (!api) return void socket.destroy();
        api.server.emit('upgrade', request, socket, head);
      },
    };
  }

  return {
    checks,
    onDrain,
    ...(http ? { http } : {}),
    ...(observability ? { metrics: observability } : {}),
    ...(onListening ? { onListening } : {}),
    close: async () => {
      stopped = true;
      for (const cleanup of cleanups) await Promise.resolve(cleanup()).catch(() => undefined);
      await db.end().catch(() => undefined);
    },
  };
}
