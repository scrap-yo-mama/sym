// SPDX-License-Identifier: AGPL-3.0-only
// Client du tunnel côté worker (tâche 2.7, 07 § 6) : une commande = une ligne `tunnel_jobs` + NOTIFY sur le canal de
// l'instance qui tient la connexion du propriétaire (`enqueueTunnelJob`). La réponse est lue dans la table (source de
// vérité), réveillée par NOTIFY `tunnel_job_done` et rattrapée par un sondage de secours. Une réponse lue est effacée de
// la table (contenu de page, minimisation). Aucune commande ne part vers l'extension d'un autre utilisateur : le job
// porte le propriétaire du run, et la passerelle comme la base le revérifient (INV5).
import {
  abandonTunnelJob,
  enqueueTunnelJob,
  forgetTunnelResult,
  readTunnelJob,
  TUNNEL_DONE_CHANNEL,
  type TunnelJobInput,
} from '@runtime/db';
import { isTunnelError, parseTunnelResult, type TunnelError, type TunnelResult } from '@runtime/core/tunnel';
import pg from 'pg';
import type { Logger } from 'pino';

/** Issue d'une commande : réponse de l'extension, ou erreur (de l'extension, de la passerelle, ou hors ligne). */
/** Délai sans prise en charge au-delà duquel un run connecté passe quand même en `waiting_tunnel`. */
const WAITING_AFTER_MS = 3000;

export type TunnelOutcome =
  | { readonly kind: 'result'; readonly result: TunnelResult }
  | { readonly kind: 'error'; readonly error: TunnelError | 'protocol_violation' | 'tunnel_offline'; readonly result?: TunnelResult };

export type TunnelSendOptions = {
  readonly signal: AbortSignal;
  /** Bascule `waiting_tunnel` tant que l'extension n'a pas pris la commande. */
  readonly onWaiting?: (waiting: boolean) => Promise<void>;
};

export interface TunnelPort {
  send(input: TunnelJobInput, options: TunnelSendOptions): Promise<TunnelOutcome>;
}

export type TunnelClientOptions = {
  pool: pg.Pool;
  /** Connexion de session pour LISTEN (`DATABASE_URL_DIRECT`, défaut `DATABASE_URL`). */
  sessionUrl: string;
  logger: Logger;
  /** Sondage de secours (ms). */
  pollMs?: number;
  /**
   * Délai pendant lequel une commande attend une extension hors ligne (redéploiement de la passerelle, service worker
   * relancé par l'alarme de 30 s) avant `tunnel_offline`. Défaut 90 s (07 § 4 : reconnexion en moins de 60 s).
   */
  offlineGraceMs?: number;
};

export class TunnelJobClient implements TunnelPort {
  readonly #options: TunnelClientOptions;
  readonly #waiters = new Map<string, Set<() => void>>();
  #listener: pg.Client | null = null;
  #closing = false;
  #retry: NodeJS.Timeout | undefined;

  constructor(options: TunnelClientOptions) {
    this.#options = options;
  }

  /**
   * LISTEN `tunnel_job_done`. Ne lève jamais : sans LISTEN (base momentanément injoignable), le sondage de secours
   * suffit et une nouvelle tentative est planifiée.
   */
  async start(): Promise<void> {
    if (this.#closing) return;
    const client = new pg.Client({ connectionString: this.#options.sessionUrl, application_name: 'runtime-worker-tunnel' });
    client.on('notification', (msg) => {
      if (msg.channel !== TUNNEL_DONE_CHANNEL || msg.payload === undefined) return;
      for (const wake of this.#waiters.get(msg.payload) ?? []) wake();
    });
    let connected = false;
    const retry = (error?: Error) => {
      if (this.#closing) return;
      if (connected && this.#listener !== client) return;
      this.#listener = null;
      this.#options.logger.warn({ err: error?.message }, 'tunnel : LISTEN indisponible, sondage de secours en attendant');
      client.end().catch(() => undefined);
      clearTimeout(this.#retry);
      this.#retry = setTimeout(() => void this.start(), 2000);
      this.#retry.unref();
    };
    client.on('error', retry);
    client.on('end', () => (connected ? retry() : undefined));
    try {
      await client.connect();
      connected = true;
      await client.query(`LISTEN "${TUNNEL_DONE_CHANNEL}"`);
      if (this.#closing) {
        await client.end().catch(() => undefined);
        return;
      }
      this.#listener = client;
    } catch (error) {
      retry(error as Error);
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    clearTimeout(this.#retry);
    const listener = this.#listener;
    this.#listener = null;
    await listener?.end().catch(() => undefined);
  }

  /** Attend un réveil pour `jobId` (NOTIFY) ou la fin du délai de sondage. */
  #wait(jobId: string, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const set = this.#waiters.get(jobId) ?? new Set();
      this.#waiters.set(jobId, set);
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.#waiters.delete(jobId);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      set.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  async send(input: TunnelJobInput, options: TunnelSendOptions): Promise<TunnelOutcome> {
    const { pool } = this.#options;
    const pollMs = this.#options.pollMs ?? 500;
    const offlineGraceMs = this.#options.offlineGraceMs ?? 90_000;
    options.signal.throwIfAborted();
    const { jobId, connected } = await enqueueTunnelJob(pool, input);
    let waiting = false;
    const setWaiting = async (value: boolean) => {
      if (waiting === value || options.onWaiting === undefined) return;
      waiting = value;
      await options.onWaiting(value);
    };
    if (!connected) await setWaiting(true);
    const started = Date.now();
    let dispatchedAt: number | null = null;
    /**
     * Instant où la passerelle a RENDU la commande après une coupure (lecture rejouable repassée en attente, U3.4) : la grâce
     * hors ligne se compte depuis là, pas depuis l'envoi, et la commande n'attend pas `timeout_ms + 15 s` une extension absente.
     */
    let releasedAt: number | null = null;
    let keepWaiting = false;
    /** Extension hors ligne : le run RESTE en `waiting_tunnel` jusqu'à sa fin (`skipped_tunnel_offline`, 04 §6). */
    const offline = async (): Promise<TunnelOutcome> => {
      await setWaiting(true);
      keepWaiting = true;
      return { kind: 'error', error: 'tunnel_offline' };
    };
    try {
      for (;;) {
        if (options.signal.aborted) {
          await abandonTunnelJob(pool, jobId, 'cancelled');
          options.signal.throwIfAborted();
        }
        const job = await readTunnelJob(pool, jobId);
        if (job === null) return { kind: 'error', error: 'protocol_violation' };
        if (job.state === 'done' || job.state === 'failed') {
          await setWaiting(false);
          const result = job.result === null || job.result === undefined ? null : parseTunnelResult(JSON.stringify(job.result));
          await forgetTunnelResult(pool, jobId);
          if (job.state === 'done') return result === null ? { kind: 'error', error: 'protocol_violation' } : { kind: 'result', result };
          const error = isTunnelError(job.error) || job.error === 'protocol_violation' ? job.error : 'fetch_failed';
          return result === null ? { kind: 'error', error } : { kind: 'error', error, result };
        }
        if (job.state === 'expired' || job.state === 'cancelled') return job.dispatched ? { kind: 'error', error: 'timeout' } : await offline();
        if (job.state === 'dispatched') {
          releasedAt = null;
          dispatchedAt ??= Date.now();
          await setWaiting(false);
          // La passerelle clôt d'elle-même un job émis à `timeout_ms + 5 s` ; filet si elle a disparu entre-temps.
          if (Date.now() - dispatchedAt > input.timeoutMs + 15_000) {
            const was = await abandonTunnelJob(pool, jobId, 'expired');
            if (was !== null) return { kind: 'error', error: 'timeout' };
            continue;
          }
        } else {
          // En attente : jamais prise, ou RENDUE après une coupure (`dispatched_at` posé, état revenu à `pending`) ; une nouvelle
          // émission remettra l'état à `dispatched` et le filet ci-dessus repartira de zéro.
          if (job.dispatched) {
            releasedAt ??= Date.now();
            dispatchedAt = null;
          }
          const since = releasedAt ?? started;
          // Extension hors ligne (ou commande non prise depuis un moment) : le run passe en `waiting_tunnel`. Une commande
          // simplement en route vers une extension connectée ne fait pas basculer l'état (aucune écriture par commande).
          if (!connected || job.dispatched || Date.now() - since > WAITING_AFTER_MS) await setWaiting(true);
          if (Date.now() - since > offlineGraceMs) {
            const was = await abandonTunnelJob(pool, jobId, 'expired');
            // Hors ligne dans les deux cas : commande jamais prise, ou rendue par la passerelle puis jamais reprise (tunnel perdu).
            if (was !== null) return await offline();
            continue;
          }
        }
        await this.#wait(jobId, pollMs, options.signal);
      }
    } finally {
      if (!keepWaiting) await setWaiting(false).catch(() => undefined);
    }
  }
}
