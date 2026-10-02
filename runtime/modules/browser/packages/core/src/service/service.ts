// SPDX-License-Identifier: AGPL-3.0-only
// Hôte de service commun à la passerelle, au nœud et au mode `all` (03 § 4, 04d § 3.3, 04b § 9) : `/healthz`, `/readyz`,
// `/metrics` sous jeton (04d § 3.1, tâche 3.7), drainage sur SIGTERM, refus de démarrer sur configuration invalide.
// Journaux : pino masqué (04d § 3.2, observability/logger.ts). Serveur `node:http` volontairement sans dépendance :
// Fastify (03 § 1) arrive avec la première route applicative (REST `/v1`, tâche 2.x) et reprend ces deux routes.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describeConfig, LOG_LEVELS, loadConfig, type BrowserConfig, type LogLevel } from '../config/load.js';
import { ConfigError } from '../config/reader.js';
import type { ServiceMode } from '../config/env-catalog.js';
import { CREDENTIAL_PREFIXES } from '../auth/api-key.js';
import { createBrowserMetrics, type BrowserMetrics } from '../observability/catalog.js';
import { metricsResponse } from '../observability/http.js';
import { createPinoLogger } from '../observability/logger.js';
import { MetricsRegistry } from '../observability/registry.js';

export type Logger = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Journal JSON par pino, une ligne par événement, au-dessus du seuil `SYMB_LOG_LEVEL`, masqué en trois couches (0.3) :
 * même un champ ou un message qui porterait un secret sort masqué (`Secret`, valeurs connues, puis motifs : `Bearer`,
 * query `token`/`t`, clés `symb_` et jetons `symt_` de la tâche 2.1), BINV6.
 */
export function createLogger(threshold: LogLevel, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const logger = createPinoLogger({ level: threshold, apiKeyPrefixes: CREDENTIAL_PREFIXES, destination: { write: (line: string) => write(line.replace(/\n$/, '')) } });
  return (level, msg, fields = {}) => {
    if (!LOG_LEVELS.includes(level)) return;
    logger[level](fields, msg);
  };
}

/** Vérification de `/readyz` : retourne `ok` ou un motif court (sans secret). Les tâches suivantes en ajoutent : base, migrations, Chromium, nœuds. */
export type ReadinessCheck = { name: string; run: () => string | Promise<string> };

export type ServiceOptions = {
  checks?: readonly ReadinessCheck[];
  /**
   * Crochets de drainage : attendus avant la fermeture (fin des sessions en cours), au plus `SHUTDOWN_GRACE_SECONDS` plus
   * la fenêtre de destruction `teardownMs` : à l'échéance de la grâce, le crochet du nœud détruit encore les sessions
   * restantes (`node_shutdown`, BINV3) et écrit `down` ; la sortie ne doit pas couper cette destruction.
   */
  onDrain?: ReadonlyArray<() => void | Promise<void>>;
  /** Fenêtre de destruction après la grâce (défaut `SHUTDOWN_TEARDOWN_MS`). */
  teardownMs?: number;
  log?: Logger;
  /** Registre de `/metrics` (défaut : métriques du rôle, 04d § 3.1). */
  metrics?: { registry: MetricsRegistry; metrics: BrowserMetrics };
};

export type ServiceHandle = {
  readonly mode: ServiceMode;
  /** Port réellement écouté (utile avec `PORT=0`). */
  readonly port: number;
  /** Vrai dès que `shutdown` est appelé : `/readyz` répond 503 `draining`. */
  readonly draining: boolean;
  /** Métriques servies par `/metrics` : les rôles y branchent leurs compteurs. */
  readonly metrics: { registry: MetricsRegistry; metrics: BrowserMetrics };
  /** Drainage borné par la grâce, puis fermeture. Idempotent. */
  shutdown(): Promise<void>;
  /** Fermeture immédiate. Idempotent. */
  close(): Promise<void>;
};

/**
 * Fenêtre de destruction après la grâce : 25 s. Avec la grâce par défaut (270 s), grâce plus fenêtre tiennent dans
 * `maxShutdownDelaySeconds` de Render (300 s, 04b § 9), avec 5 s de marge avant le SIGKILL de la plateforme ; une grâce
 * au-delà de 275 s mange cette fenêtre (à régler avec le blueprint, tâche 5.1). La fermeture forcée d'un Chromium est
 * bornée à 10 s (04b § 4) : la fenêtre la couvre.
 */
export const SHUTDOWN_TEARDOWN_MS = 25_000;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } as const;

function send(request: IncomingMessage, response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { ...JSON_HEADERS, ...headers, 'content-length': Buffer.byteLength(payload) });
  response.end(request.method === 'HEAD' ? undefined : payload);
}

export async function startService(config: BrowserConfig, options: ServiceOptions = {}): Promise<ServiceHandle> {
  const log = options.log ?? createLogger(config.logLevel);
  // La clé est chargée quand la configuration l'est : c'est la condition `MASTER_KEY chargée` de 04d § 3.3.
  const checks: ReadinessCheck[] = [{ name: 'master_key', run: () => (config.masterKey.reveal().length > 0 ? 'ok' : 'absente') }, ...(options.checks ?? [])];
  const observability = options.metrics ?? (() => {
    const registry = new MetricsRegistry();
    return { registry, metrics: createBrowserMetrics(registry, config.mode) };
  })();
  let draining = false;
  let closed: Promise<void> | undefined;
  let shutdownRun: Promise<void> | undefined;

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?', 1)[0];
    const known = path === '/healthz' || path === '/readyz' || path === '/metrics';
    if (!known) return send(request, response, 404, { error: 'not_found' });
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(request, response, 405, { error: 'method_not_allowed' }, { allow: 'GET, HEAD' });
    if (path === '/healthz') return send(request, response, 200, { status: 'ok' });
    if (path === '/metrics') {
      void metricsResponse(observability.registry, config.metricsToken, request.headers.authorization).then(
        (res) => {
          response.writeHead(res.status, { ...res.headers, 'content-length': Buffer.byteLength(res.body) });
          response.end(request.method === 'HEAD' ? undefined : res.body);
        },
        () => send(request, response, 500, { error: 'internal_error' }),
      );
      return;
    }
    void readiness().then(
      ({ status, body }) => send(request, response, status, body),
      () => send(request, response, 500, { error: 'internal_error' }),
    );
  });

  async function readiness(): Promise<{ status: number; body: unknown }> {
    if (draining) return { status: 503, body: { status: 'draining' } };
    const results: Record<string, string> = {};
    for (const check of checks) {
      try {
        results[check.name] = await check.run();
      } catch {
        // Le message d'une exception peut contenir une URL de base ou un secret : seul le nom de la vérification est journalisé.
        log('error', 'readiness_check_failed', { check: check.name });
        results[check.name] = 'erreur';
      }
    }
    const ready = Object.values(results).every((value) => value === 'ok');
    return { status: ready ? 200 : 503, body: { status: ready ? 'ready' : 'unready', mode: config.mode, checks: results } };
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  log('info', 'listening', { mode: config.mode, port, config: describeConfig({ ...config, port }) });

  const close = (): Promise<void> => {
    closed ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 2000).unref();
    });
    return closed;
  };

  const shutdown = (): Promise<void> => {
    draining = true;
    shutdownRun ??= (async () => {
      log('info', 'draining', { graceSeconds: config.shutdownGraceSeconds });
      let timer: NodeJS.Timeout | undefined;
      const grace = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, config.shutdownGraceSeconds * 1000 + (options.teardownMs ?? SHUTDOWN_TEARDOWN_MS));
      });
      const hooks = Promise.allSettled((options.onDrain ?? []).map(async (hook) => hook())).then(() => undefined);
      await Promise.race([hooks, grace]);
      clearTimeout(timer);
      await close();
      log('info', 'stopped', {});
    })();
    return shutdownRun;
  };

  return {
    mode: config.mode,
    metrics: observability,
    port,
    get draining() {
      return draining;
    },
    shutdown,
    close,
  };
}

/** Rôle assemblé par `RunOptions.prepare` : `onListening` reçoit le port réel (utile avec `PORT=0`, URL du nœud en mode `all`). */
export type PreparedRole = ServiceOptions & { close?: () => Promise<void>; onListening?: (port: number) => void };

export type RunOptions = ServiceOptions & {
  env?: Record<string, string | undefined>;
  argv?: readonly string[];
  /** Mode appliqué quand `SYMB_MODE` est absent (binaire du nœud : `node`). */
  defaultMode?: ServiceMode;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  exit?: (code: number) => void;
  /** Abonne SIGTERM et SIGINT au drainage (défaut : oui). */
  handleSignals?: boolean;
  /**
   * Assemblage du rôle (tâche 5.1), appelé une fois la configuration validée et avant l'écoute : vérifications de `/readyz`,
   * crochets de drainage et fermeture des ressources (base, battement, Chromium). Ne doit pas attendre la base : un service
   * démarre et répond `/healthz` même base injoignable. Une exception arrête le démarrage (code 1, message sans détail).
   */
  prepare?: (config: BrowserConfig, log: Logger) => Promise<PreparedRole>;
};

/**
 * Point d'entrée commun : charge la configuration, refuse de démarrer sur une valeur invalide (code 1, message qui nomme
 * chaque variable en cause), puis écoute. `--check-config` valide sans écouter (code 0 ou 1).
 */
export async function runService(options: RunOptions = {}): Promise<ServiceHandle | undefined> {
  const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  const stderr = options.stderr ?? ((line) => process.stderr.write(`${line}\n`));
  const exit = options.exit ?? ((code) => process.exit(code));
  const env = options.env ?? process.env;

  let config: BrowserConfig;
  try {
    config = loadConfig(env, options.defaultMode === undefined ? {} : { defaultMode: options.defaultMode });
  } catch (error) {
    stderr(error instanceof ConfigError ? error.message : 'Configuration illisible (erreur inattendue au chargement).');
    exit(1);
    return undefined;
  }
  for (const warning of config.warnings) stderr(warning);

  if ((options.argv ?? []).includes('--check-config')) {
    stdout(`SYM Browser : configuration valide (${describeConfig(config)}).`);
    exit(0);
    return undefined;
  }

  const log = options.log ?? createLogger(config.logLevel, stdout);
  let prepared: PreparedRole = {};
  if (options.prepare) {
    try {
      prepared = await options.prepare(config, log);
    } catch (error) {
      // Le message peut contenir une URL de base : seul le nom de l'erreur sort.
      stderr(`Démarrage impossible : échec de la préparation du rôle ${config.mode} (${(error as Error).name ?? 'erreur'}).`);
      exit(1);
      return undefined;
    }
  }
  const releaseResources = prepared.close ?? (async () => undefined);

  let service: ServiceHandle;
  try {
    service = await startService(config, {
      ...options,
      log,
      checks: [...(options.checks ?? []), ...(prepared.checks ?? [])],
      onDrain: [...(options.onDrain ?? []), ...(prepared.onDrain ?? [])],
    });
  } catch (error) {
    await releaseResources().catch(() => undefined);
    const code = (error as NodeJS.ErrnoException).code;
    stderr(code === 'EADDRINUSE' ? `PORT ${config.port} déjà utilisé : libérez-le ou choisissez un autre port.` : `Démarrage impossible : ${code ?? 'erreur d’écoute'} (PORT ${config.port}).`);
    exit(1);
    return undefined;
  }

  prepared.onListening?.(service.port);
  if (prepared.close) service = withRelease(service, releaseResources);

  if (options.handleSignals !== false) {
    let stopping = false;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        if (stopping) return;
        stopping = true;
        void service.shutdown().then(() => exit(0));
      });
    }
  }
  return service;
}

/** Libère les ressources du rôle (base, battement, Chromium) après l'arrêt du serveur, une seule fois. */
function withRelease(service: ServiceHandle, release: () => Promise<void>): ServiceHandle {
  let released: Promise<void> | undefined;
  const once = (): Promise<void> => (released ??= release().catch(() => undefined));
  return {
    mode: service.mode,
    port: service.port,
    get draining() {
      return service.draining;
    },
    shutdown: async () => {
      await service.shutdown();
      await once();
    },
    close: async () => {
      await service.close();
      await once();
    },
  };
}
