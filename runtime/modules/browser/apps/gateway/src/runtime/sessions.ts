// SPDX-License-Identifier: AGPL-3.0-only
// Sessions du mode `all` (cdc/sym-browser 03 § 4 ; tâche 5.1, constat F-20261002-01, R1 de l'audit 5.3) : le nœud du
// processus sert les sessions que la passerelle du même processus lui confie, sans `POST /internal/sessions`.
//   - lanceur de la passerelle (`SessionLauncher`) : politique `egress` de la requête retenue, puis `SessionSupervisor.start`
//     (tâche 1.2) ; libération et prolongation sur le superviseur ;
//   - hôte des sessions (tâche 1.7) entre le superviseur et le pool : répertoire `sessions/{id}`, egress PROPRE à la
//     session (tâches 1.5, 1.6 : proxy amont en ligne compris), contexte neuf (shared), destruction complète (04c § 3.2) ;
//   - Chromium dedicated lancé sur l'egress de SA session (BINV2 tenu par ce chemin de production, plus seulement par les
//     bancs) : le lanceur dedicated du pool ne reçoit que l'URL de proxy de la session demandée, et refuse sans elle ;
//   - relais interne du nœud (tâche 2.3) sur `/internal/sessions/…`, jeton de nœud tiré au démarrage (jamais exposé : en mode
//     `all` la passerelle du processus est son seul client), appels de la boucle locale seulement ;
//   - comptage (tâche 2.6, BINV5) : compteurs de l'egress vers le compteur du nœud, clôtures dans `usage.wal` puis en base.
// Pas encore câblé dans ce chemin (constat F-20261002-03 du journal) : profils persistants (3.1), enregistrements (3.3),
// vue en direct (3.2), fichiers (1.8), webhooks (2.5), profils de proxy nommés (1.6) ; une session qui les demande échoue
// (`launch_failed`) au lieu de démarrer sans eux. Modes séparés (`gateway` + `node`) : `POST /internal/sessions` (04b § 12)
// reste à servir par le nœud.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { ConfigError, egressGuardFromConfig, type BrowserConfig, type Logger } from '@sym-browser/core';
import { createPgSessionStore } from '@sym-browser/db';
import type { BrowserPool, PoolLease } from '@sym-browser/node';
import { EgressPolicyError, type SessionEgress as ProxyEgress } from '@sym-browser/node/egress';
import { createNodeRelay } from '@sym-browser/node/relay';
import { SessionHost, SessionSupervisor, type HostLease, type SessionAcquireRequest, type SharedSessionInput } from '@sym-browser/node/sessions';
import { DEFAULT_IP_ECHO_URL, ProxyUnreachableError, startUpstreamSessionEgress, type UpstreamSession } from '@sym-browser/node/upstream';
import { replayUsageWal, UsageMeter, UsageWal } from '@sym-browser/node/usage';
import type { CreateSessionRequest, EgressPolicy } from '@sym/contracts/browser';
import type pg from 'pg';
import type { SessionLauncher } from '../api/index.js';

/** Champs de la requête de création transmis au contexte d'une session shared (04 § 3) ; le nœud les revalide. */
const SHARED_FIELDS = ['viewport', 'locale', 'timezoneId', 'userAgent', 'extraHTTPHeaders', 'geolocation', 'colorScheme', 'acceptDownloads', 'storageState'] as const;
/** Options servies par des tâches pas encore câblées dans ce chemin (F-20261002-03) : refusées plutôt qu'ignorées. */
const NOT_WIRED = ['profile', 'recordings'] as const;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const SWEEP_INTERVAL_MS = 60_000;

export type AllModeSessions = {
  launcher: SessionLauncher;
  /** Jeton du relais interne (passerelle ↔ nœud du processus). */
  nodeToken: string;
  /** Relais interne : `true` si la demande lui revenait (traitée ou refusée). */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  handleRequest(request: IncomingMessage, response: ServerResponse): boolean;
  /** Clôtures de comptage rejouées en base, une fois les migrations appliquées. */
  replayUsage(): Promise<void>;
  /** Nœud isolé (battement perdu) : sessions détruites sans écriture d'état. */
  isolate(): Promise<void>;
  /** Drainage (04b § 9) : plus de nouvelle session ; attente jusqu'à `deadline`, puis fin `node_shutdown`. */
  drain(deadline: Date): Promise<void>;
  close(): Promise<void>;
};

type AllModeSessionsDeps = {
  config: BrowserConfig;
  db: pg.Pool;
  pool: Pick<BrowserPool, 'acquire'>;
  /** Egress de chaque session, lu par le lanceur dedicated du pool (proxy de lancement de SA session). */
  egresses: Map<string, ProxyEgress>;
  log: Logger;
};

function pathOf(request: IncomingMessage): string {
  return (request.url ?? '/').split('?', 1)[0] ?? '/';
}

export async function assembleAllModeSessions(deps: AllModeSessionsDeps): Promise<AllModeSessions> {
  const { config, db, egresses, log } = deps;
  const onError = (error: unknown): void => log('warn', 'session_error', { error: (error as Error).name, code: (error as { code?: string }).code });
  const guard = egressGuardFromConfig(config);
  const policies = new Map<string, EgressPolicy>();
  /** Egress amont de chaque session tenue : lecture et remplacement à chaud de la politique (`/v1/sessions/{id}/egress`). */
  const upstreams = new Map<string, UpstreamSession>();
  const leases = new Map<string, HostLease>();
  const store = createPgSessionStore(db);
  // Répertoire de travail inutilisable : arrêt du démarrage avec un message qui nomme la variable et le code système.
  const wal = await UsageWal.open(join(config.dataDir, 'usage', `${config.node.id}.wal`)).catch((error: unknown) => {
    const code = (error as { code?: unknown }).code;
    throw new ConfigError([`SYMB_DATA_DIR : journal de comptage impossible à ouvrir sous ${config.dataDir} (${typeof code === 'string' ? code : 'erreur'})`]);
  });
  const meter = new UsageMeter({ nodeId: config.node.id });
  const host = new SessionHost({
    pool: deps.pool,
    dataDir: config.dataDir,
    egress: async ({ sessionId, tenantId }) => {
      const upstream = await startUpstreamSessionEgress(policies.get(sessionId) ?? {}, {
        guard,
        tenantId,
        echoUrl: config.ipEchoUrl ?? DEFAULT_IP_ECHO_URL,
        onDenied: (error) => log('info', 'egress_denied', { sessionId, reason: error.reason }),
        // Superviseur déclaré plus bas : l'egress ne le sollicite qu'une fois la session démarrée.
        onBudgetEnd: () => void supervisor.end(sessionId, 'budget_exceeded').catch(onError),
        onCounters: (state) => meter.observe(sessionId, state),
      });
      const egress = upstream.egress;
      egresses.set(sessionId, egress);
      upstreams.set(sessionId, upstream);
      return {
        proxyUrl: egress.url,
        close: async () => egress.shut(),
        stop: async () => {
          egresses.delete(sessionId);
          upstreams.delete(sessionId);
          await egress.close();
        },
      };
    },
  });

  const supervisor = new SessionSupervisor({
    nodeId: config.node.id,
    store,
    usage: { meter, wal },
    onError,
    pool: {
      acquire: async (request: SessionAcquireRequest) => {
        const lease = await host.acquire(request);
        leases.set(request.sessionId, lease);
        return {
          signal: lease.signal,
          release: async () => {
            leases.delete(request.sessionId);
            await lease.release();
          },
        } satisfies Pick<PoolLease, 'signal' | 'release'>;
      },
    },
  });

  const nodeToken = config.nodeToken?.reveal() ?? randomBytes(32).toString('base64url');
  const relay = createNodeRelay({
    nodeToken,
    onActivity: (sessionId) => supervisor.activity(sessionId),
    onError,
    ...(config.limits.cdpMaxMessageBytes > 0 ? { maxMessageBytes: config.limits.cdpMaxMessageBytes } : {}),
    sessions: {
      get: (sessionId) => {
        const lease = leases.get(sessionId);
        const egress = egresses.get(sessionId);
        if (!lease || !egress || lease.signal.aborted || !host.accepting(sessionId)) return undefined;
        return {
          type: lease.type,
          playwright: lease.wsEndpoint,
          cdp: lease.cdpEndpoint ?? null,
          egressProxyUrl: egress.url,
          downloadsDir: lease.type === 'dedicated' ? lease.dir.downloads : null,
          release: async () => void (await supervisor.end(sessionId, 'released')),
        };
      },
    },
  });

  void host.sweep().catch(onError);
  const sweeper = setInterval(() => void host.sweep().catch(onError), SWEEP_INTERVAL_MS);
  sweeper.unref();

  /** Plafond des prolongations : création + durée maximale du client (04 § 3), lu en base. */
  const maxExpiresAt = async (sessionId: string, fallback: number): Promise<number> => {
    const { rows } = await db.query<{ max: number }>(
      'SELECT (extract(epoch FROM s.created_at + make_interval(secs => t.max_session_seconds)) * 1000)::float8 AS max FROM sessions s JOIN tenants t ON t.id = s.tenant_id WHERE s.id = $1::uuid',
      [sessionId],
    );
    return rows[0]?.max ?? fallback;
  };

  const launcher: SessionLauncher = {
    async launch(request) {
      const options: CreateSessionRequest = request.options;
      const missing = NOT_WIRED.filter((field) => options[field] !== undefined);
      if (missing.length > 0) {
        log('warn', 'session_option_not_wired', { sessionId: request.sessionId, options: missing });
        return { ok: false, code: 'launch_failed' };
      }
      policies.set(request.sessionId, options.egress ?? {});
      try {
        const expiresAt = request.expiresAt.getTime();
        const shared: SharedSessionInput = {};
        if (request.type === 'shared') for (const field of SHARED_FIELDS) if (options[field] !== undefined) Object.assign(shared, { [field]: options[field] });
        const outcome = await supervisor.start({
          sessionId: request.sessionId,
          type: request.type,
          tenantId: request.tenantId,
          expiresAt,
          maxExpiresAt: await maxExpiresAt(request.sessionId, expiresAt),
          idleTimeoutSeconds: request.idleTimeoutSeconds,
          ...(request.type === 'dedicated' && options.launchArgs !== undefined ? { launchArgs: options.launchArgs } : {}),
          ...(request.type === 'shared' ? { options: shared } : {}),
        });
        if (outcome.ok) return { ok: true };
        log('warn', 'session_start_failed', { sessionId: request.sessionId, code: outcome.code });
        return { ok: false, code: 'launch_failed' };
      } finally {
        policies.delete(request.sessionId);
      }
    },
    async release(sessionId) {
      return (await supervisor.end(sessionId, 'released')).ok ? 'released' : 'not_held';
    },
    async extend(sessionId, seconds) {
      return (await supervisor.extend(sessionId, seconds)).ok ? 'extended' : 'not_held';
    },
    // Egress de la session : tenu tant que le bail l'est (arrêt ordonné de la session : plus de lecture ni de remplacement).
    async egressState(sessionId) {
      const upstream = upstreams.get(sessionId);
      if (upstream === undefined || !leases.has(sessionId)) return { ok: false, code: 'not_held' };
      return { ok: true, state: upstream.egress.state() };
    },
    async replaceEgress(sessionId, policy) {
      const upstream = upstreams.get(sessionId);
      if (upstream === undefined || !leases.has(sessionId)) return { ok: false, code: 'not_held' };
      try {
        return { ok: true, state: await upstream.replace(policy) };
      } catch (error) {
        // Politique refusée ou amont injoignable : l'egress garde sa politique courante, sans identifiant dans la réponse.
        if (error instanceof EgressPolicyError) return { ok: false, code: 'invalid_option', field: error.field, reason: error.message };
        if (error instanceof ProxyUnreachableError) return { ok: false, code: 'proxy_unreachable', reason: error.details.reason };
        throw error;
      }
    },
  };

  /** Relais interne : boucle locale seulement (la passerelle du processus), puis jeton de nœud vérifié par le relais. */
  const internal = (request: IncomingMessage): boolean => pathOf(request).startsWith('/internal/');
  const local = (request: IncomingMessage): boolean => LOOPBACK.has(request.socket.remoteAddress ?? '');

  return {
    launcher,
    nodeToken,
    handleUpgrade(request, socket, head) {
      if (!internal(request)) return false;
      if (!local(request) || !relay.handleUpgrade(request, socket, head)) socket.destroy();
      return true;
    },
    handleRequest(request, response) {
      if (!internal(request)) return false;
      if (local(request) && relay.handleRequest(request, response)) return true;
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
      return true;
    },
    async replayUsage() {
      const report = await replayUsageWal(wal, store);
      if (report.inserted + report.replaced > 0) log('info', 'usage_wal_replayed', { ...report });
    },
    isolate: () => supervisor.isolate(),
    async drain(deadline) {
      supervisor.drain();
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), Math.max(0, deadline.getTime() - Date.now()));
      try {
        await supervisor.whenEmpty(timeout.signal);
      } finally {
        clearTimeout(timer);
      }
      await supervisor.shutdown();
    },
    async close() {
      clearInterval(sweeper);
      await supervisor.shutdown().catch(onError);
      await relay.close().catch(onError);
      await wal.close().catch(onError);
    },
  };
}
