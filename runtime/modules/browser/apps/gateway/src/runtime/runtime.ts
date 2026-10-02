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
// Ce fichier ne monte pas encore l'API REST (2.2) ni le relais WSS (2.3) : il assemble ce dont dépend `/readyz`.
import { bootstrapApiKeyRecord, type BrowserConfig, type Logger, type PreparedRole, type ReadinessCheck } from '@sym-browser/core';
import { currentSchemaVersion, ensureFirstApiKey, expectedSchemaVersion, markNodeState, migrateUp, readyNodeExists, recordHeartbeat, sweepLostNodes } from '@sym-browser/db';
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
import { BROWSER_ENGINE } from '@sym/contracts/browser';
import pg from 'pg';

export type RuntimeDeps = {
  log: Logger;
  /** Lanceur de Chromium ; défaut : Playwright derrière le proxy de lancement fermé (tests : lanceur factice). */
  launcher?: BrowserLauncher;
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
    if (!launch) {
      proxy = await startClosedLaunchProxy();
      const groups = new OwnedProcessGroups();
      launch = playwrightLauncher({ launchProxyUrl: proxy.url, groups });
      sweep = () => groups.sweep();
    }
    const launcher = launch;
    const { options, capacity } = nodePoolOptions(config.node, {
      launch: launcher,
      ...(sweep ? { sweep } : {}),
      onEvent: (event) => log(event.kind === 'launch_failed' ? 'warn' : 'debug', 'pool', { ...event }),
    });
    const browsers = new BrowserPool(options);
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
        slotsTotal: stats.slotsTotal,
        slotsFree: chromium === 'ok' ? stats.slotsFree : 0,
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
      if (config.mode === 'all') url = `http://127.0.0.1:${port}`;
      heartbeat = startHeartbeat({
        beat,
        // Sessions locales : le superviseur (tâche 1.2) est branché avec le relais et le routage (2.3, 2.4).
        isolate: async () => undefined,
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
      await deps.drainSessions?.({ deadline: new Date(Date.now() + config.shutdownGraceSeconds * 1000), nodeId });
      heartbeat?.stop();
      await closePool();
      await markNodeState(db, { nodeId, state: 'down' }).catch(() => log('warn', 'drain_state_failed', { nodeId }));
      log('info', 'node_down', { nodeId });
    });
    cleanups.push(
      () => heartbeat?.stop(),
      () => closePool(),
    );
  }

  return {
    checks,
    onDrain,
    ...(onListening ? { onListening } : {}),
    close: async () => {
      stopped = true;
      for (const cleanup of cleanups) await Promise.resolve(cleanup()).catch(() => undefined);
      await db.end().catch(() => undefined);
    },
  };
}
