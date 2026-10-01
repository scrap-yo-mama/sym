// SPDX-License-Identifier: AGPL-3.0-only
// Passerelle tunnel WSS (tâche 2.7, 07 § 5-6, 08b § 2, INV5, INV10).
// - Une WSS par utilisateur : la plus récente gagne, l'ancienne est fermée en 4409 (sur cette instance ou sur celle qui
//   la tenait, par NOTIFY `k:`). Jeton hors URL, dans le premier message (`hello`) ; Origin vérifiée à l'ouverture ;
//   schéma strict (violation : 4400) ; limite de débit (4429) ; révocation : fermeture immédiate (4401, NOTIFY `r:`).
// - Routage : la table `tunnel_jobs` fait foi. Le worker notifie le canal DE CETTE INSTANCE (`tunnel_cmd_<instance>`,
//   `tunnels.gateway_instance`) ; rattrapage à la connexion et sondage de secours des jobs en attente.
// - Avant d'émettre une commande : propriétaire du run = utilisateur du jeton (INV5, sinon refus journalisé), jeu fermé
//   de commandes, liste blanche CDP, domaine et URL contrôlés par la garde des sites (INV10), E6 refusé (ADR 0001).
// - Réponses découpées (≤ 1 Mio chacune, `maxPayload`), réassemblées ici, validées, écrites en transaction puis NOTIFY
//   du job_id au worker. Compression désactivée.
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { checkSiteDomain } from '@runtime/core/net';
import {
  checkCdpCommand,
  commandUrl,
  parseAgentStepArgs,
  parseAgentStepWireResult,
  parseExtensionFrame,
  parseFetchArgs,
  parseFetchResponse,
  parseTunnelResult,
  ResultAssembler,
  TUNNEL_HELLO_TIMEOUT_MS,
  TUNNEL_IDLE_TIMEOUT_MS,
  TUNNEL_MAX_PAYLOAD,
  TUNNEL_PING_MS,
  WS_CLOSE,
  type TunnelError,
} from '@runtime/core/tunnel';
import {
  appendAudit,
  attachTunnelConnection,
  claimTunnelJob,
  completeTunnelJob,
  detachTunnelConnection,
  gatewayChannel,
  invalidTunnels,
  normalizeGatewayInstance,
  parseGatewaySignal,
  pendingTunnelJobs,
  resolveExtensionToken,
  tunnelJobRoute,
  withActor,
  type DispatchedJob,
} from '@runtime/db';
import type { Role } from '@runtime/core';
import type { FastifyBaseLogger } from 'fastify';
import pg from 'pg';
import type { WebSocket } from 'ws';
import type { ExtensionOriginPolicy } from '../config.js';
import { AttemptLimiter } from '../rate-limit.js';

/** Échecs de `hello` par IP sur 15 min avant refus (4429). */
const HELLO_MAX_FAILURES = 20;
/** Messages reçus par connexion sur une fenêtre de 10 s (réponses découpées comprises). */
const MESSAGES_PER_WINDOW = 400;
const MESSAGE_WINDOW_MS = 10_000;
/** Au-delà de ces octets en attente d'envoi, la passerelle attend avant d'émettre (contre-pression). */
const SEND_BUFFER_HIGH = 4 * 1024 * 1024;
/** Commandes en vol par connexion. */
const MAX_INFLIGHT = 8;

export type GatewayOptions = {
  pool: pg.Pool;
  /** Connexion de session pour LISTEN (jamais un pooler en mode transaction). */
  sessionUrl: string;
  instance?: string | null;
  /** Journal (celui de l'application Fastify, créée après la passerelle). */
  logger: () => FastifyBaseLogger;
  /** Période du sondage de secours (ms). */
  pollMs?: number;
  /** Période de revalidation des jetons des connexions ouvertes (ms). */
  revalidateMs?: number;
  /** Connexion muette au-delà de ce délai : fermée (4408) et détachée (défaut : 3 pings, `TUNNEL_IDLE_TIMEOUT_MS`). */
  idleMs?: number;
};

type Inflight = { attempt: number; assembler: ResultAssembler; timer: NodeJS.Timeout; cmd: DispatchedJob['cmd'] };

type Connection = {
  socket: WebSocket;
  ip: string;
  phase: 'hello' | 'open' | 'closed';
  tunnelId: string;
  ownerId: string;
  email: string;
  role: Role;
  epoch: number;
  inflight: Map<string, Inflight>;
  windowStart: number;
  messages: number;
  /** Dernier message reçu (ping compris) : délai d'inactivité. */
  lastSeen: number;
  helloTimer?: NodeJS.Timeout;
};

/**
 * Origine d'une ouverture de WSS : une extension de la liste (celle publiée par défaut), ou toute extension en mode
 * développement explicite (`allowAny`). Jamais une origine web ni une requête sans Origin. Liste vide hors
 * développement : aucune.
 */
export function tunnelOriginAllowed(origin: string | undefined, policy: ExtensionOriginPolicy): boolean {
  if (typeof origin !== 'string') return false;
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
  if (match === null) return false;
  return policy.allowAny || policy.ids.includes(match[1]!);
}

/** Domaine d'une commande et URL éventuelle : la garde des sites (INV10) s'applique avant toute émission. */
export function guardCommand(job: Pick<DispatchedJob, 'cmd' | 'domain' | 'args' | 'allowWriteActions' | 'execution'>): { ok: true } | { ok: false; error: TunnelError; reason: string } {
  const verdict = checkSiteDomain(job.domain);
  if (!verdict.ok || verdict.domain !== job.domain) return { ok: false, error: 'domain_not_allowed', reason: `domaine refusé (${verdict.ok ? 'non normalisé' : verdict.reason})` };
  // E6 limité au serveur (ADR 0001) : aucun moteur agentique tiers ne traverse le tunnel.
  if (job.execution === 'agent') return { ok: false, error: 'method_not_allowed', reason: 'E6 limité au serveur' };
  const hostGuard = (url: URL | null): boolean => url !== null && checkSiteDomain(url.hostname).ok;
  switch (job.cmd) {
    case 'http_fetch':
    case 'page_fetch': {
      const parsed = parseFetchArgs(job.args, job.domain, job.allowWriteActions);
      if (!parsed.ok) return { ok: false, error: parsed.error, reason: parsed.reason };
      if (!hostGuard(new URL(parsed.args.url))) return { ok: false, error: 'domain_not_allowed', reason: 'adresse privée ou nom interne' };
      return { ok: true };
    }
    case 'page_script': {
      const args = job.args as { method?: unknown; params?: unknown } | null;
      if (typeof args !== 'object' || args === null || Array.isArray(args) || Object.keys(args).some((k) => k !== 'method' && k !== 'params')) {
        return { ok: false, error: 'method_not_allowed', reason: 'args page_script hors contrat' };
      }
      const check = checkCdpCommand(args.method, args.params);
      if (!check.ok) return { ok: false, error: 'method_not_allowed', reason: check.reason };
      if (args.method === 'Page.navigate') {
        const url = commandUrl((args.params as { url?: unknown } | undefined)?.url, job.domain);
        if (!hostGuard(url)) return { ok: false, error: 'domain_not_allowed', reason: 'navigation hors du domaine connecté' };
      }
      return { ok: true };
    }
    case 'agent_step': {
      const parsed = parseAgentStepArgs(job.args);
      if (!parsed.ok) return { ok: false, error: 'method_not_allowed', reason: parsed.reason };
      if (parsed.action.kind === 'navigate' && !hostGuard(commandUrl(parsed.action.url, job.domain))) {
        return { ok: false, error: 'domain_not_allowed', reason: 'navigation hors du domaine connecté' };
      }
      return { ok: true };
    }
  }
}

/** Corps d'une réponse validé selon la commande ; `null` = hors contrat (jamais compté comme un succès). */
function validResultBody(cmd: DispatchedJob['cmd'], body: unknown): boolean {
  switch (cmd) {
    case 'http_fetch':
    case 'page_fetch':
      return body === null || parseFetchResponse(body, Number.MAX_SAFE_INTEGER) !== null;
    case 'agent_step':
      return body === null || parseAgentStepWireResult(body) !== null;
    case 'page_script':
      return true;
  }
}

/** Lecture de l'état hors du rétrécissement de type (il change pendant les attentes asynchrones). */
const isClosed = (conn: Connection): boolean => conn.phase === 'closed';

export class TunnelGateway {
  readonly instance: string;
  readonly #options: GatewayOptions;
  readonly #byTunnel = new Map<string, Connection>();
  readonly #byOwner = new Map<string, Connection>();
  readonly #helloFailures = new AttemptLimiter({ max: HELLO_MAX_FAILURES, windowMs: 15 * 60 * 1000 });
  #listener: pg.Client | null = null;
  #pollTimer: NodeJS.Timeout | undefined;
  #revalidateTimer: NodeJS.Timeout | undefined;
  #idleTimer: NodeJS.Timeout | undefined;
  #closing = false;
  #reconnectTimer: NodeJS.Timeout | undefined;
  /** Commandes émises (tests, métriques). */
  dispatched = 0;
  /** Refus de routage INV5 (tests, métriques). */
  routeDenied = 0;

  constructor(options: GatewayOptions) {
    this.#options = options;
    this.instance = normalizeGatewayInstance(options.instance ?? `${hostname()}_${process.pid}_${randomBytes(3).toString('hex')}`);
  }

  get log(): FastifyBaseLogger {
    return this.#options.logger();
  }

  /** Connexions ouvertes sur cette instance. */
  connections(): number {
    return this.#byTunnel.size;
  }

  async start(): Promise<void> {
    await this.#listen();
    this.#pollTimer = setInterval(() => void this.#poll(), this.#options.pollMs ?? 2000);
    this.#pollTimer.unref();
    this.#revalidateTimer = setInterval(() => void this.#revalidate(), this.#options.revalidateMs ?? 60_000);
    this.#revalidateTimer.unref();
    // Connexion à moitié ouverte (veille, coupure sans FIN) : sans fermeture, elle resterait « connectée » en base et les
    // commandes y expireraient en `timeout` au lieu de passer en `waiting_tunnel`.
    const idleMs = this.#options.idleMs ?? TUNNEL_IDLE_TIMEOUT_MS;
    this.#idleTimer = setInterval(() => this.#closeIdle(idleMs), Math.max(100, Math.floor(idleMs / 4)));
    this.#idleTimer.unref();
  }

  /** Ferme (4408) les connexions ouvertes sans aucun message depuis `idleMs` ; la ligne `tunnels` est détachée. */
  #closeIdle(idleMs: number): void {
    const now = Date.now();
    for (const conn of new Set(this.#byTunnel.values())) {
      if (conn.phase === 'open' && now - conn.lastSeen > idleMs) {
        this.log.info({ tunnel: conn.tunnelId, idleMs }, 'passerelle : connexion muette fermée');
        this.#close(conn, WS_CLOSE.idleTimeout, 'idle timeout');
        // Pair injoignable : la poignée de fermeture n'aboutira pas, la socket est coupée peu après (sans attendre les 30 s
        // de `ws`), le temps qu'un pair encore vivant reçoive le code.
        setTimeout(() => conn.socket.terminate(), 2000).unref();
      }
    }
  }

  async #listen(): Promise<void> {
    const client = new pg.Client({ connectionString: this.#options.sessionUrl, application_name: 'runtime-tunnel-gateway' });
    client.on('notification', (msg) => {
      if (msg.channel === gatewayChannel(this.instance)) void this.#onSignal(msg.payload);
    });
    const lost = (error?: Error) => {
      if (this.#closing || this.#listener !== client) return;
      this.#listener = null;
      this.log.warn({ err: error?.message }, 'passerelle : LISTEN perdu, sondage de secours en attendant');
      client.end().catch(() => undefined);
      this.#reconnectTimer = setTimeout(() => void this.#listen().catch((e: unknown) => lost(e as Error)), 2000);
      this.#reconnectTimer.unref();
    };
    client.on('error', lost);
    client.on('end', () => lost());
    await client.connect();
    await client.query(`LISTEN "${gatewayChannel(this.instance)}"`);
    this.#listener = client;
  }

  async close(): Promise<void> {
    this.#closing = true;
    clearInterval(this.#pollTimer);
    clearInterval(this.#revalidateTimer);
    clearInterval(this.#idleTimer);
    clearTimeout(this.#reconnectTimer);
    const conns = [...new Set([...this.#byTunnel.values()])];
    for (const conn of conns) this.#close(conn, 1001, 'instance going away');
    await Promise.allSettled(conns.map((c) => this.#detach(c)));
    const listener = this.#listener;
    this.#listener = null;
    await listener?.end().catch(() => undefined);
  }

  // --- Connexions ------------------------------------------------------------------------------------------------------

  /** Nouvelle WSS (Origin et absence de paramètres d'URL déjà vérifiées à l'ouverture). */
  accept(socket: WebSocket, ip: string): void {
    const conn: Connection = { socket, ip, phase: 'hello', tunnelId: '', ownerId: '', email: '', role: 'member', epoch: 0, inflight: new Map(), windowStart: Date.now(), messages: 0, lastSeen: Date.now() };
    conn.helloTimer = setTimeout(() => this.#close(conn, WS_CLOSE.helloTimeout, 'hello expected'), TUNNEL_HELLO_TIMEOUT_MS);
    // Gestionnaires attachés tout de suite : aucun message perdu pendant les attentes asynchrones.
    let queue = Promise.resolve();
    socket.on('message', (data, isBinary) => {
      conn.lastSeen = Date.now();
      queue = queue.then(() => this.#onMessage(conn, data as Buffer, isBinary)).catch((error: unknown) => {
        this.log.error({ err: (error as Error).message }, 'passerelle : erreur de traitement');
        this.#close(conn, 1011, 'internal error');
      });
    });
    socket.on('close', () => {
      const was = conn.phase;
      conn.phase = 'closed';
      clearTimeout(conn.helloTimer);
      if (was === 'open') void this.#detach(conn).catch((error: unknown) => this.log.error({ err: (error as Error).message }, 'passerelle : détachement impossible'));
    });
    socket.on('error', () => undefined);
  }

  #close(conn: Connection, code: number, reason: string): void {
    if (conn.phase === 'closed') return;
    const was = conn.phase;
    conn.phase = 'closed';
    clearTimeout(conn.helloTimer);
    try {
      conn.socket.close(code, reason);
    } catch {
      conn.socket.terminate();
    }
    if (was === 'open') void this.#detach(conn).catch((error: unknown) => this.log.error({ err: (error as Error).message }, 'passerelle : détachement impossible'));
  }

  async #detach(conn: Connection): Promise<void> {
    if (this.#byTunnel.get(conn.tunnelId) === conn) this.#byTunnel.delete(conn.tunnelId);
    if (this.#byOwner.get(conn.ownerId) === conn) this.#byOwner.delete(conn.ownerId);
    for (const entry of conn.inflight.values()) clearTimeout(entry.timer);
    conn.inflight.clear();
    if (conn.tunnelId === '') return;
    await detachTunnelConnection(this.#options.pool, { tunnelId: conn.tunnelId, instance: this.instance, epoch: conn.epoch });
  }

  async #onMessage(conn: Connection, data: Buffer, isBinary: boolean): Promise<void> {
    if (conn.phase === 'closed') return;
    const now = Date.now();
    if (now - conn.windowStart > MESSAGE_WINDOW_MS) {
      conn.windowStart = now;
      conn.messages = 0;
    }
    conn.messages += 1;
    if (conn.messages > MESSAGES_PER_WINDOW) return this.#close(conn, WS_CLOSE.rateLimited, 'rate limited');
    const frame = isBinary ? null : parseExtensionFrame(data.toString('utf8'));
    if (frame === null) return this.#close(conn, WS_CLOSE.protocol, 'protocol violation');
    if (conn.phase === 'hello') {
      if (frame.type !== 'hello') return this.#close(conn, WS_CLOSE.protocol, 'hello expected');
      return this.#onHello(conn, frame.token);
    }
    switch (frame.type) {
      case 'hello':
        return this.#close(conn, WS_CLOSE.protocol, 'duplicate hello');
      case 'ping':
        conn.socket.send(JSON.stringify({ type: 'pong' }));
        return;
      case 'result':
        return this.#onResult(conn, frame);
    }
  }

  async #onHello(conn: Connection, token: string): Promise<void> {
    clearTimeout(conn.helloTimer);
    if (this.#helloFailures.blocked(conn.ip)) return this.#close(conn, WS_CLOSE.rateLimited, 'too many attempts');
    const identity = await resolveExtensionToken(this.#options.pool, token);
    if (identity === null) {
      this.#helloFailures.fail(conn.ip);
      return this.#close(conn, WS_CLOSE.unauthorized, 'unauthorized');
    }
    if (conn.phase === 'closed') return;
    const attached = await attachTunnelConnection(this.#options.pool, { tunnelId: identity.tunnelId, ownerId: identity.userId, instance: this.instance });
    if (attached === null) return this.#close(conn, WS_CLOSE.unauthorized, 'unauthorized');
    // Une seule WSS active par utilisateur : toute connexion locale du même utilisateur (ou du même appareil) est fermée.
    for (const other of [this.#byOwner.get(identity.userId), this.#byTunnel.get(identity.tunnelId)]) {
      if (other !== undefined && other !== conn) {
        // La ligne est déjà rattachée à la nouvelle connexion : l'ancienne ne la détache pas.
        if (this.#byTunnel.get(other.tunnelId) === other) this.#byTunnel.delete(other.tunnelId);
        if (this.#byOwner.get(other.ownerId) === other) this.#byOwner.delete(other.ownerId);
        other.tunnelId = '';
        this.#close(other, WS_CLOSE.replaced, 'replaced by a newer connection');
      }
    }
    // La WSS a pu se fermer pendant les attentes : la ligne qu'on vient de rattacher est rendue.
    if (isClosed(conn)) {
      await detachTunnelConnection(this.#options.pool, { tunnelId: identity.tunnelId, instance: this.instance, epoch: attached.epoch });
      return;
    }
    Object.assign(conn, { phase: 'open', tunnelId: identity.tunnelId, ownerId: identity.userId, email: identity.email, role: identity.role, epoch: attached.epoch });
    this.#byTunnel.set(conn.tunnelId, conn);
    this.#byOwner.set(conn.ownerId, conn);
    conn.socket.send(JSON.stringify({ type: 'welcome', email: identity.email, ping_ms: TUNNEL_PING_MS, max_payload: TUNNEL_MAX_PAYLOAD }));
    await this.#audit(conn, 'tunnel.connected', 'success', { epoch: attached.epoch, replaced: attached.kicked.length });
    // Rattrapage : les commandes en attente de cet utilisateur partent dès la connexion.
    for (const pending of await pendingTunnelJobs(this.#options.pool, [conn.ownerId])) {
      if (conn.phase !== 'open') break;
      await this.#dispatch(conn, pending.jobId);
    }
  }

  async #audit(conn: Connection, action: string, outcome: 'success' | 'denied', meta: Record<string, unknown>): Promise<void> {
    await withActor(this.#options.pool, conn.ownerId === '' ? null : { userId: conn.ownerId, role: conn.role }, (client) =>
      appendAudit(client, {
        actorUserId: conn.ownerId === '' ? null : conn.ownerId,
        actorVia: 'extension',
        actorRef: null,
        ip: conn.ip,
        userAgent: null,
        action,
        targetType: 'tunnel',
        targetId: conn.tunnelId === '' ? null : conn.tunnelId,
        outcome,
        meta,
      }),
    ).catch((error: unknown) => this.log.warn({ err: (error as Error).message }, 'passerelle : audit impossible'));
  }

  // --- Commandes -------------------------------------------------------------------------------------------------------

  async #onSignal(payload: string | undefined): Promise<void> {
    const signal = parseGatewaySignal(payload);
    if (signal === null) return;
    try {
      if (signal.kind === 'revoked') {
        const conn = this.#byTunnel.get(signal.tunnelId);
        if (conn !== undefined) {
          await this.#audit(conn, 'tunnel.closed', 'success', { reason: 'revoked' });
          this.#close(conn, WS_CLOSE.unauthorized, 'revoked');
        }
        return;
      }
      if (signal.kind === 'kick') {
        const conn = this.#byTunnel.get(signal.tunnelId);
        if (conn !== undefined && !(conn.tunnelId === signal.newTunnelId && conn.epoch === signal.epoch)) {
          this.#byTunnel.delete(conn.tunnelId);
          if (this.#byOwner.get(conn.ownerId) === conn) this.#byOwner.delete(conn.ownerId);
          conn.tunnelId = '';
          this.#close(conn, WS_CLOSE.replaced, 'replaced by a newer connection');
        }
        return;
      }
      const route = await tunnelJobRoute(this.#options.pool, signal.jobId);
      if (route === null) return;
      const conn = (route.tunnelId === null ? undefined : this.#byTunnel.get(route.tunnelId)) ?? this.#byOwner.get(route.ownerId);
      if (conn !== undefined && conn.phase === 'open') await this.#dispatch(conn, signal.jobId);
    } catch (error) {
      this.log.error({ err: (error as Error).message }, 'passerelle : signal non traité');
    }
  }

  /** Sondage de secours : jobs en attente des utilisateurs connectés ici (coupure de LISTEN, contre-pression). */
  async #poll(): Promise<void> {
    if (this.#byOwner.size === 0 || this.#closing) return;
    try {
      for (const pending of await pendingTunnelJobs(this.#options.pool, [...this.#byOwner.keys()])) {
        const conn = (pending.tunnelId === null ? undefined : this.#byTunnel.get(pending.tunnelId)) ?? this.#byOwner.get(pending.ownerId);
        if (conn !== undefined && conn.phase === 'open') await this.#dispatch(conn, pending.jobId);
      }
    } catch (error) {
      this.log.warn({ err: (error as Error).message }, 'passerelle : sondage impossible');
    }
  }

  /**
   * Jetons revalidés : appareil révoqué, supprimé ou expiré, compte désactivé → 4401 (l'extension oublie son appairage) ;
   * appareil valide dont la ligne est détachée ou rattachée ailleurs (NOTIFY `k:` perdu) → 4409 (remplacée : elle garde
   * son appairage).
   */
  async #revalidate(): Promise<void> {
    const conns = [...this.#byTunnel.values()];
    if (conns.length === 0) return;
    try {
      const invalid = new Map((await invalidTunnels(this.#options.pool, conns.map((c) => ({ tunnelId: c.tunnelId, epoch: c.epoch })), this.instance)).map((r) => [r.tunnelId, r.reason]));
      for (const conn of conns) {
        const reason = invalid.get(conn.tunnelId);
        if (reason === 'unauthorized') this.#close(conn, WS_CLOSE.unauthorized, 'unauthorized');
        else if (reason === 'replaced') {
          // La ligne n'est plus à cette connexion : elle ne la détache pas.
          if (this.#byTunnel.get(conn.tunnelId) === conn) this.#byTunnel.delete(conn.tunnelId);
          if (this.#byOwner.get(conn.ownerId) === conn) this.#byOwner.delete(conn.ownerId);
          conn.tunnelId = '';
          this.#close(conn, WS_CLOSE.replaced, 'replaced by a newer connection');
        }
      }
    } catch (error) {
      this.log.warn({ err: (error as Error).message }, 'passerelle : revalidation impossible');
    }
  }

  async #dispatch(conn: Connection, jobId: string): Promise<void> {
    if (conn.phase !== 'open' || conn.inflight.size >= MAX_INFLIGHT || conn.inflight.has(jobId)) return;
    if (conn.socket.bufferedAmount > SEND_BUFFER_HIGH) return; // contre-pression : le sondage reprendra
    const outcome = await claimTunnelJob(this.#options.pool, { jobId, tunnelId: conn.tunnelId, ownerId: conn.ownerId, instance: this.instance });
    if (outcome.kind === 'skip') return;
    if (outcome.kind === 'refused') {
      this.log.warn({ jobId, tunnel: conn.tunnelId }, 'passerelle : domaine non connecté par le propriétaire du run, commande refusée');
      return;
    }
    if (outcome.kind === 'denied') {
      this.routeDenied += 1;
      this.log.warn({ jobId, tunnel: conn.tunnelId }, 'passerelle : run d’un autre utilisateur refusé (INV5)');
      await this.#audit(conn, 'tunnel.route_denied', 'denied', { jobId, reason: 'owner_mismatch' });
      return;
    }
    const job = outcome.job;
    const verdict = guardCommand(job);
    if (!verdict.ok) {
      this.log.warn({ jobId, cmd: job.cmd, error: verdict.error }, `passerelle : commande refusée avant émission (${verdict.reason})`);
      await completeTunnelJob(this.#options.pool, { jobId, tunnelId: conn.tunnelId, instance: this.instance, attempt: job.attempt, outcome: { ok: false, error: verdict.error } });
      return;
    }
    if (conn.phase !== 'open') return; // la connexion s'est fermée : `detach` rend le job
    const timer = setTimeout(() => void this.#expire(conn, jobId), job.timeoutMs + 5000);
    conn.inflight.set(jobId, { attempt: job.attempt, assembler: new ResultAssembler(), timer, cmd: job.cmd });
    this.dispatched += 1;
    conn.socket.send(
      JSON.stringify({
        type: 'cmd',
        job_id: job.jobId,
        run_id: job.runId,
        cmd: job.cmd,
        domain: job.domain,
        args: job.args,
        timeout_ms: job.timeoutMs,
        allow_write_actions: job.allowWriteActions,
      }),
    );
  }

  async #expire(conn: Connection, jobId: string): Promise<void> {
    const entry = conn.inflight.get(jobId);
    if (entry === undefined) return;
    conn.inflight.delete(jobId);
    await completeTunnelJob(this.#options.pool, { jobId, tunnelId: conn.tunnelId, instance: this.instance, attempt: entry.attempt, outcome: { ok: false, error: 'timeout' } }).catch(() => false);
  }

  async #onResult(conn: Connection, frame: { job_id: string; seq: number; last: boolean; data: string }): Promise<void> {
    const entry = conn.inflight.get(frame.job_id);
    // Réponse à un job qui n'est pas (ou plus) en vol sur cette connexion : ignorée (rejeu, délai dépassé).
    if (entry === undefined) return;
    const step = entry.assembler.push(frame);
    if (!step.done) return;
    conn.inflight.delete(frame.job_id);
    clearTimeout(entry.timer);
    const base = { jobId: frame.job_id, tunnelId: conn.tunnelId, instance: this.instance, attempt: entry.attempt };
    if ('error' in step) {
      await completeTunnelJob(this.#options.pool, { ...base, outcome: { ok: false, error: step.error === 'too_large' ? 'response_too_large' : 'protocol_violation' } });
      if (step.error === 'protocol') this.#close(conn, WS_CLOSE.protocol, 'protocol violation');
      return;
    }
    const result = parseTunnelResult(step.text);
    if (result === null || !validResultBody(entry.cmd, result.body)) {
      await completeTunnelJob(this.#options.pool, { ...base, outcome: { ok: false, error: 'protocol_violation' } });
      return;
    }
    await completeTunnelJob(this.#options.pool, {
      ...base,
      outcome: result.ok ? { ok: true, result } : { ok: false, error: result.error ?? 'fetch_failed', result },
    });
  }
}
