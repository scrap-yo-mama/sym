// SPDX-License-Identifier: AGPL-3.0-only
// Mode réseau `tunnel` (tâche 2.7, 07 § 3-5, 04 §3.2) : la stratégie déclarative s'exécute dans le navigateur de
// l'utilisateur, par son extension, commande par commande (jeu fermé). Même boucle déclarative qu'E1-E3 : seul le
// transport change.
// - E1 `fetch` et E2 `fetch_in_page` : `page_fetch` (commande par défaut : `fetch` dans un onglet du site, origine,
//   cookies et jetons CSRF du site) ;
// - E3 `playwright` déclaratif : `page_script`, méthodes CDP de la liste blanche (navigation, attente du rendu par
//   `DOM.querySelector`, lecture par `DOM.getOuterHTML`) ;
// - E6 `agent` : refusé (ADR 0001, E6 limité au serveur) ; un script E3 généré ne passe pas par le tunnel (aucun code ne
//   s'exécute dans l'extension).
// Défi : détecté par l'extension ou ici sur la réponse, il ARRÊTE le run sur-le-champ : plus aucune commande n'est
// envoyée (`challenge_in_tunnel`, la main revient à l'humain, aucune prise de contrôle offerte). Jamais d'escalade
// réseau ni de proposition du tunnel après un refus (INV6) : le tunnel n'est choisi que par la stratégie.
import {
  classifyStatus,
  encodeRequestBody,
  runDeclarative,
  type DeclarativeRunOptions,
  type DeclarativeRunResult,
  type HttpExchange,
  type Transport,
} from '@runtime/core/exec';
import { DslError, type DeclarativeSpec } from '@runtime/core';
import { DomainNotAllowedError } from '@runtime/core/net';
import { commandUrl, detectResponseChallenge, FETCH_DEFAULT_MAX_BYTES, parseFetchResponse, type FetchResponse, type TunnelCommand, type TunnelResult } from '@runtime/core/tunnel';
import type { TunnelOutcome, TunnelPort } from '../tunnel/client.js';

/** Délai d'une commande du tunnel (07 §8). */
const COMMAND_TIMEOUT_MS = 30_000;
/** Attente du rendu en E3 (sélecteur des enregistrements), par sondages `DOM.querySelector`. */
const RENDER_WAIT_MS = 10_000;
const RENDER_POLL_MS = 500;

export type TunnelStop = 'challenge_in_tunnel' | 'tunnel_offline';

export type TunnelSessionBase = { runId: string; ownerId: string; domain: string; allowWriteActions: boolean; execution: string; trace?: unknown };

/** Session de tunnel d'un essai : compte les commandes, s'arrête net sur un défi. */
export class TunnelSession {
  readonly #port: TunnelPort;
  readonly #base: TunnelSessionBase;
  readonly #signal: AbortSignal;
  readonly #onWaiting: ((waiting: boolean) => Promise<void>) | undefined;
  /** Raison d'arrêt sans classe d'échec : plus aucune commande après elle. */
  stop: TunnelStop | null = null;
  /** Refus de l'extension qui demande une action de l'utilisateur (site non connecté dans ce navigateur). */
  needsUser = false;
  /** Commandes envoyées (et commandes refusées localement après un arrêt, toujours 0 envoi). */
  sent = 0;
  refusedAfterStop = 0;

  constructor(port: TunnelPort, base: TunnelSessionBase, signal: AbortSignal, onWaiting?: (waiting: boolean) => Promise<void>) {
    this.#port = port;
    this.#base = base;
    this.#signal = signal;
    this.#onWaiting = onWaiting;
  }

  get domain(): string {
    return this.#base.domain;
  }

  /** Envoie une commande ; après un défi ou une extension hors ligne, refuse localement sans rien envoyer. */
  async command(cmd: TunnelCommand, args: unknown, replayable: boolean): Promise<TunnelOutcome> {
    if (this.stop !== null) {
      this.refusedAfterStop += 1;
      throw new TunnelStopError(this.stop);
    }
    this.sent += 1;
    const outcome = await this.#port.send(
      {
        runId: this.#base.runId,
        ownerId: this.#base.ownerId,
        cmd,
        domain: this.#base.domain,
        args,
        timeoutMs: COMMAND_TIMEOUT_MS,
        replayable,
        allowWriteActions: this.#base.allowWriteActions,
        execution: this.#base.execution,
        ...(this.#base.trace === undefined ? {} : { trace: this.#base.trace }),
      },
      {
        signal: this.#signal,
        ...(this.#onWaiting === undefined
          ? {}
          : {
              onWaiting: async (waiting: boolean) => {
                // Bascule d'état best effort : une perte de bail est vue par le battement du run.
                await this.#onWaiting!(waiting).catch(() => undefined);
              },
            }),
      },
    );
    if (outcome.kind === 'error') {
      if (outcome.error === 'challenge_in_tunnel') this.stop = 'challenge_in_tunnel';
      else if (outcome.error === 'tunnel_offline') this.stop = 'tunnel_offline';
      else if (outcome.error === 'permission_required') this.needsUser = true;
      if (this.stop !== null) throw new TunnelStopError(this.stop);
    }
    return outcome;
  }

  /** Une réponse de page est un défi : arrêt immédiat, aucune commande de plus. */
  challenged(): never {
    this.stop = 'challenge_in_tunnel';
    throw new TunnelStopError(this.stop);
  }
}

class TunnelStopError extends Error {
  readonly reason: TunnelStop;
  constructor(reason: TunnelStop) {
    super(`tunnel : ${reason}`);
    this.name = 'TunnelStopError';
    this.reason = reason;
  }
}

/** Erreur de commande → erreur que la classification des transports comprend. */
function commandError(outcome: Extract<TunnelOutcome, { kind: 'error' }>, url: string): Error {
  switch (outcome.error) {
    case 'domain_not_allowed':
      return new DomainNotAllowedError(safeHost(url));
    case 'response_too_large':
      return new DslError('response_too_large', 'réponse au-delà de max_response_bytes');
    case 'timeout':
      return Object.assign(new Error('tunnel : délai dépassé'), { name: 'TimeoutError' });
    case 'fetch_failed':
    case 'tab_unavailable':
    case 'tunnel_disconnected':
      return Object.assign(new Error(`tunnel : ${outcome.error}`), { code: 'ECONNRESET' });
    default:
      return new DslError('unsupported', `tunnel : ${outcome.error}`);
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid';
  }
}

function fetchBody(result: TunnelResult, maxBytes: number): FetchResponse {
  const response = parseFetchResponse(result.body, maxBytes);
  if (response === null) throw new DslError('unsupported', 'tunnel : réponse hors contrat');
  return response;
}

/**
 * Contrôle de défi sur une réponse (défense en profondeur : l'extension l'a déjà fait). Corps lu s'il est HTML ou si la
 * réponse est une erreur, même en JSON (XHR DataDome : 403 + captcha-delivery.com).
 */
function checkChallenge(session: TunnelSession, response: { status: number; headers: Readonly<Record<string, string>>; body: string; url: string }): void {
  if (detectResponseChallenge(response)) session.challenged();
}

/** E1 / E2 en tunnel : `page_fetch` (fetch dans un onglet du site, cookies du navigateur de l'utilisateur) ; aussi l'étape 0 et la reconnaissance d'une enquête à session (2.1). */
export function pageFetchTransport(session: TunnelSession, maxBytes: number): Transport {
  return async (request): Promise<HttpExchange> => {
    const { body, contentType } = encodeRequestBody(request);
    const headers: Record<string, string> = { ...request.headers };
    if (contentType !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = contentType;
    const method = request.method.toUpperCase();
    const outcome = await session.command('page_fetch', { url: request.url, method, headers, ...(body === undefined ? {} : { body }), max_bytes: maxBytes }, method === 'GET' || method === 'HEAD');
    if (outcome.kind === 'error') throw commandError(outcome, request.url);
    const response = fetchBody(outcome.result, maxBytes);
    checkChallenge(session, response);
    return { status: response.status, headers: response.headers, body: response.body, url: response.url === '' ? request.url : response.url };
  };
}

type CdpValue = Record<string, unknown> | null;

async function cdp(session: TunnelSession, method: string, params: Record<string, unknown>, url: string, replayable = true): Promise<CdpValue> {
  const outcome = await session.command('page_script', { method, params }, replayable);
  if (outcome.kind === 'error') throw commandError(outcome, url);
  const body = outcome.result.body;
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/**
 * E3 déclaratif en tunnel : navigation (`Page.navigate`, l'extension attend la fin du chargement et rend statut et
 * en-têtes du document), attente du rendu (`DOM.querySelector`), lecture du DOM rendu (`DOM.getOuterHTML`).
 */
function pageScriptTransport(session: TunnelSession, spec: DeclarativeSpec, maxBytes: number, signal: AbortSignal): Transport {
  const renderSelector = spec.sources.find((s) => s.from === 'html')?.records;
  return async (request): Promise<HttpExchange> => {
    if (request.method !== 'GET' || request.body !== undefined) throw new DslError('unsupported', 'E3 déclaratif : requêtes GET seulement');
    const nav = await cdp(session, 'Page.navigate', { url: request.url }, request.url);
    const status = typeof nav?.['status'] === 'number' ? nav['status'] : 0;
    const headers: Record<string, string> = {};
    if (typeof nav?.['headers'] === 'object' && nav['headers'] !== null) {
      for (const [k, v] of Object.entries(nav['headers'] as Record<string, unknown>)) if (typeof v === 'string') headers[k.toLowerCase()] = v;
    }
    const finalUrl = typeof nav?.['url'] === 'string' ? nav['url'] : request.url;
    // Défense en profondeur (l'extension refuse déjà) : une navigation redirigée hors du domaine connecté n'est jamais lue.
    if (commandUrl(finalUrl, session.domain) === null) throw new DomainNotAllowedError(safeHost(finalUrl));
    const doc = await cdp(session, 'DOM.getDocument', { depth: 0 }, request.url);
    const root = (doc?.['root'] as { nodeId?: unknown } | undefined)?.nodeId;
    if (typeof root !== 'number') throw new DslError('unsupported', 'tunnel : document illisible');
    if (renderSelector !== undefined && classifyStatus(status) === null) {
      const deadline = Date.now() + RENDER_WAIT_MS;
      for (;;) {
        const found = await cdp(session, 'DOM.querySelector', { nodeId: root, selector: renderSelector }, request.url);
        if (typeof found?.['nodeId'] === 'number' && found['nodeId'] !== 0) break;
        if (Date.now() > deadline || signal.aborted) break;
        await new Promise((r) => setTimeout(r, RENDER_POLL_MS));
      }
    }
    const outer = await cdp(session, 'DOM.getOuterHTML', { nodeId: root }, request.url);
    const html = typeof outer?.['outerHTML'] === 'string' ? outer['outerHTML'] : '';
    if (Buffer.byteLength(html) > maxBytes) throw new DslError('response_too_large', 'réponse au-delà de max_response_bytes');
    const response = { status, headers, body: html, url: finalUrl };
    checkChallenge(session, response);
    return response;
  };
}

export type TunnelRunOptions = Omit<DeclarativeRunOptions, 'transport'> & { readonly session: TunnelSession; readonly execution: 'fetch' | 'fetch_in_page' | 'playwright' };

/** Exécution déclarative par le tunnel. Un arrêt (défi, hors ligne) est rendu à part, jamais comme une classe d'échec. */
export async function runTunnelExecutor(options: TunnelRunOptions): Promise<{ result: DeclarativeRunResult; stop: TunnelStop | null; needsUser: boolean }> {
  const maxBytes = options.spec.limits?.max_response_bytes ?? FETCH_DEFAULT_MAX_BYTES;
  const transport = options.execution === 'playwright' ? pageScriptTransport(options.session, options.spec, maxBytes, options.signal) : pageFetchTransport(options.session, maxBytes);
  const result = await runDeclarative({ ...options, transport });
  return { result, stop: options.session.stop, needsUser: options.session.needsUser };
}
