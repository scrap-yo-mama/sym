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
import { createBrowserMetrics, type BrowserMetrics } from '../observability/catalog.js';
import { metricsResponse } from '../observability/http.js';
import { createPinoLogger } from '../observability/logger.js';
import { MetricsRegistry } from '../observability/registry.js';

export type Logger = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Journal JSON par pino, une ligne par événement, au-dessus du seuil `SYMB_LOG_LEVEL`, masqué en trois couches (0.3) :
 * même un champ ou un message qui porterait un secret sort masqué.
 */
export function createLogger(threshold: LogLevel, write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Logger {
  const logger = createPinoLogger({ level: threshold, destination: { write: (line: string) => write(line.replace(/\n$/, '')) } });
  return (level, msg, fields = {}) => {
    if (!LOG_LEVELS.includes(level)) return;
    logger[level](fields, msg);
  };
}

/** Vérification de `/readyz` : retourne `ok` ou un motif court (sans secret). Les tâches suivantes en ajoutent : base, migrations, Chromium, nœuds. */
export type ReadinessCheck = { name: string; run: () => string | Promise<string> };

export type ServiceOptions = {
  checks?: readonly ReadinessCheck[];
  /** Crochets de drainage : attendus (au plus `SHUTDOWN_GRACE_SECONDS`) avant la fermeture, ex. fin des sessions en cours. */
  onDrain?: ReadonlyArray<() => void | Promise<void>>;
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
        timer = setTimeout(resolve, config.shutdownGraceSeconds * 1000);
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

  let service: ServiceHandle;
  try {
    service = await startService(config, { ...options, log: options.log ?? createLogger(config.logLevel, stdout) });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    stderr(code === 'EADDRINUSE' ? `PORT ${config.port} déjà utilisé : libérez-le ou choisissez un autre port.` : `Démarrage impossible : ${code ?? 'erreur d’écoute'} (PORT ${config.port}).`);
    exit(1);
    return undefined;
  }

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
