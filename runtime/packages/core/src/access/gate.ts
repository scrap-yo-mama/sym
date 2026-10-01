// SPDX-License-Identifier: AGPL-3.0-only
// Garde robots.txt (tâche 1.11, 17 §2, RFC 9309, INV11) : lue par origine AVANT toute requête de contenu, dans tous les
// modes d'exécution (E1 et `ctx.fetch` par la session réseau, E2 et E3 par le contexte Chromium), sans aucune option
// pour l'ignorer. Règles :
// - `GET /robots.txt` sous la garde SSRF et la cadence par domaine, un saut à la fois, 5 redirections au plus (au-delà
//   ou en boucle : injoignable, par précaution) ;
// - 2xx : analysé sur ses 500 premiers Kio (le reste est ignoré, la dernière ligne coupée aussi) ;
// - 4xx : aucune règle, tout est permis (sauf 429 : injoignable, par précaution) ;
// - 5xx, réseau, redirection refusée : `robots_unreachable`, rien n'est collecté (`erreur`, backoff) ;
// - cache par origine de 24 h au plus (fichier lu ou 4xx) ; un échec n'est mémorisé que pour l'essai en cours ;
// - correspondance sur le jeton produit, puis `*` ; `Crawl-delay` devient un plancher de cadence.
import { AccessRefusedError } from '../net/access-refusal.js';
import { findDomainNotAllowed } from '../net/domain-lock.js';
import { findSsrfBlocked } from '../net/guard.js';
import type { NetworkSession } from '../net/modes/session.js';
import type { AccessDecision, ExecFailure, RequestPacer } from '../exec/types.js';
import { matchRules, parseRobots, PRODUCT_TOKEN, robotsTarget, selectGroup, type RobotsFile, type SelectedGroup } from './robots.js';

/** Taille lue d'un robots.txt : 500 Kio (RFC 9309 : au moins 500 Kio ; le reste est ignoré). */
export const ROBOTS_MAX_BYTES = 500 * 1024;
/** Redirections suivies pour lire robots.txt (17 §2 : 5, à valider). */
export const ROBOTS_MAX_REDIRECTS = 5;
/** Durée de vie du cache (17 §2 : 24 h au plus). */
export const ROBOTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Délai d'une lecture de robots.txt (un saut). */
export const ROBOTS_FETCH_TIMEOUT_MS = 15_000;
/** Plafond d'un `Crawl-delay` retenu (24 h) : au-delà de l'attente maximale, la cadence refuse de toute façon. */
const MAX_CRAWL_DELAY_MS = 24 * 60 * 60 * 1000;

/** Un saut de lecture de robots.txt (redirection NON suivie). */
export type RobotsFetchResult = {
  readonly status: number;
  readonly location: string | null;
  /** Corps décodé, borné à `ROBOTS_MAX_BYTES` octets (ligne coupée retirée). */
  readonly body: string;
  readonly truncated: boolean;
};

export type RobotsFetcher = (url: string, signal: AbortSignal) => Promise<RobotsFetchResult>;

export type RobotsState =
  | { readonly kind: 'rules'; readonly origin: string; readonly fetchedAt: number; readonly status: number; readonly file: RobotsFile; readonly truncated: boolean }
  | { readonly kind: 'absent'; readonly origin: string; readonly fetchedAt: number; readonly status: number }
  | { readonly kind: 'unreachable'; readonly origin: string; readonly fetchedAt: number; readonly detail: string; readonly status: number | null };

/** Verdict détaillé (`AccessDecision` + état lu et règle appliquée). */
export type RobotsDecision =
  | { readonly allowed: true; readonly crawlDelayMs: number | null; readonly state: RobotsState; readonly rule: string | null }
  | { readonly allowed: false; readonly failure: ExecFailure; readonly state: RobotsState | null; readonly rule: string | null };

/** Cache des robots.txt lus, partagé entre les essais d'un worker (clé : origine ; jamais un échec). */
export class RobotsCache {
  readonly #entries = new Map<string, { state: RobotsState; expiresAt: number }>();
  readonly #max: number;
  constructor(max = 5000) {
    this.#max = max;
  }
  get(origin: string, now: number): RobotsState | undefined {
    const entry = this.#entries.get(origin);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now) {
      this.#entries.delete(origin);
      return undefined;
    }
    return entry.state;
  }
  set(state: RobotsState, now: number, ttlMs: number): void {
    if (state.kind === 'unreachable') return;
    if (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }
    this.#entries.set(state.origin, { state, expiresAt: now + Math.min(ttlMs, ROBOTS_CACHE_TTL_MS) });
  }
  clear(): void {
    this.#entries.clear();
  }
}

export const ROBOTS_DISALLOWED: ExecFailure = Object.freeze({ failure_class: 'robots_disallowed', retryable: false, detail: 'robots_disallowed' });
const unreachable = (detail: string): ExecFailure => ({ failure_class: 'robots_unreachable', retryable: true, detail });

class RobotsPacingRefusal extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`robots.txt : cadence refusée (${reason})`);
    this.reason = reason;
  }
}

class RobotsGuardRefusal extends Error {
  readonly failure: ExecFailure;
  constructor(failure: ExecFailure) {
    super(failure.detail);
    this.failure = failure;
  }
}

export type RobotsGateOptions = {
  /** Lecteur d'un saut de robots.txt (`sessionRobotsFetcher`) : session réseau SANS contrôle robots (pas de récursion). */
  readonly fetch: RobotsFetcher;
  /** Cadence par domaine : la lecture de robots.txt est une requête vers le domaine comme une autre. */
  readonly pacer?: RequestPacer;
  readonly cache?: RobotsCache;
  readonly token?: string;
  readonly now?: () => number;
  readonly ttlMs?: number;
  readonly signal?: AbortSignal;
  /** Délai d'un saut (défaut 15 s). */
  readonly timeoutMs?: number;
};

function originOf(url: URL): string {
  return url.origin;
}

/**
 * Garde robots.txt d'un essai (ou d'une enquête). `check(url)` : verdict avant toute requête de contenu ; `checkUrl`
 * pour la session réseau (lève `AccessRefusedError`) ; `crawlDelayMs(url)` pour la cadence.
 */
export class RobotsGate {
  readonly #options: RobotsGateOptions;
  readonly #token: string;
  readonly #now: () => number;
  readonly #memo = new Map<string, Promise<RobotsState>>();
  readonly #settled = new Map<string, RobotsState>();

  constructor(options: RobotsGateOptions) {
    this.#options = options;
    this.#token = options.token ?? PRODUCT_TOKEN;
    this.#now = options.now ?? Date.now;
  }

  /** État de robots.txt pour l'origine de `url` (lu une fois par essai ; cache partagé de 24 h au plus). */
  state(url: string | URL): Promise<RobotsState> {
    const origin = originOf(typeof url === 'string' ? new URL(url) : url);
    let pending = this.#memo.get(origin);
    if (pending === undefined) {
      pending = this.#load(origin).then((state) => {
        this.#settled.set(origin, state);
        return state;
      });
      // Refus de cadence ou de garde : rien n'est mémorisé, un nouvel appel retentera.
      pending.catch(() => this.#memo.delete(origin));
      this.#memo.set(origin, pending);
    }
    return pending;
  }

  /** Groupe retenu pour l'origine, si robots.txt est déjà lu. */
  #selected(state: RobotsState): SelectedGroup | null {
    return state.kind === 'rules' ? selectGroup(state.file, this.#token) : null;
  }

  /** Verdict avant une requête vers `url` (aucune requête de contenu tant qu'il n'est pas rendu). */
  check = async (url: string): Promise<RobotsDecision> => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return { allowed: false, failure: { failure_class: 'code_error', retryable: false, detail: 'invalid_url' }, state: null, rule: null };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, failure: { failure_class: 'code_error', retryable: false, detail: 'invalid_url' }, state: null, rule: null };
    }
    let state: RobotsState;
    try {
      state = await this.state(parsed);
    } catch (error) {
      if (error instanceof RobotsPacingRefusal) return { allowed: false, failure: { failure_class: 'rate_limited', retryable: true, detail: `pacing_${error.reason}` }, state: null, rule: null };
      if (error instanceof RobotsGuardRefusal) return { allowed: false, failure: error.failure, state: null, rule: null };
      throw error;
    }
    if (state.kind === 'unreachable') return { allowed: false, failure: unreachable(state.detail), state, rule: null };
    if (state.kind === 'absent') return { allowed: true, crawlDelayMs: null, state, rule: null };
    const group = this.#selected(state) as SelectedGroup;
    const verdict = matchRules(group.rules, robotsTarget(parsed));
    if (!verdict.allowed) return { allowed: false, failure: ROBOTS_DISALLOWED, state, rule: verdict.rule };
    return { allowed: true, crawlDelayMs: crawlDelayOf(group), state, rule: verdict.rule };
  };

  /** Contrôle d'URL de la session réseau (`NetworkSessionOptions.checkUrl`) : lève `AccessRefusedError` sur un refus. */
  checkUrl = async (url: URL): Promise<void> => {
    const decision = await this.check(url.href);
    if (!decision.allowed) {
      const cls = decision.failure.failure_class;
      throw new AccessRefusedError({
        failure_class: cls === 'robots_disallowed' || cls === 'robots_unreachable' || cls === 'rate_limited' ? cls : 'forbidden',
        retryable: decision.failure.retryable,
        detail: decision.failure.detail,
      });
    }
  };

  /** `Crawl-delay` connu pour l'origine de `url` (ms), `null` si aucun ou robots.txt pas encore lu. */
  crawlDelayMs = (url: string): number | null => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return null;
    }
    const state = this.#settled.get(origin);
    if (state === undefined) return null;
    const group = this.#selected(state);
    return group === null ? null : crawlDelayOf(group);
  };

  /** Verdict au format du port d'exécution (`AccessCheck`). */
  access = async (url: string): Promise<AccessDecision> => {
    const d = await this.check(url);
    return d.allowed ? { allowed: true, crawlDelayMs: d.crawlDelayMs } : { allowed: false, failure: d.failure };
  };

  async #load(origin: string): Promise<RobotsState> {
    const now = this.#now();
    const cached = this.#options.cache?.get(origin, now);
    if (cached !== undefined) return cached;
    const state = await this.#fetchState(origin);
    this.#options.cache?.set(state, this.#now(), this.#options.ttlMs ?? ROBOTS_CACHE_TTL_MS);
    return state;
  }

  async #fetchState(origin: string): Promise<RobotsState> {
    const fetchedAt = this.#now();
    const down = (detail: string, status: number | null = null): RobotsState => ({ kind: 'unreachable', origin, fetchedAt, detail, status });
    let url = `${origin}/robots.txt`;
    const seen = new Set<string>([url]);
    for (let hop = 0; ; hop++) {
      const pacer = this.#options.pacer;
      if (pacer !== undefined) {
        const slot = await pacer.acquire(url);
        if (!slot.granted) throw new RobotsPacingRefusal(slot.reason);
      }
      let result: RobotsFetchResult;
      try {
        const signals = [AbortSignal.timeout(this.#options.timeoutMs ?? ROBOTS_FETCH_TIMEOUT_MS)];
        if (this.#options.signal !== undefined) signals.push(this.#options.signal);
        result = await this.#options.fetch(url, AbortSignal.any(signals));
      } catch (error) {
        this.#options.signal?.throwIfAborted();
        // Hôte refusé par la garde SSRF : le contenu le serait aussi ; la classe reste celle de la garde.
        if (findSsrfBlocked(error) !== undefined) throw new RobotsGuardRefusal({ failure_class: 'forbidden', retryable: false, detail: 'ssrf_blocked' });
        await pacer?.report(url, { status: 0, retryAfter: null, failureClass: 'robots_unreachable' }).catch(() => undefined);
        return down(findDomainNotAllowed(error) !== undefined ? 'robots_redirect_not_allowed' : 'robots_network');
      }
      await pacer?.report(url, { status: result.status, retryAfter: null, failureClass: result.status >= 500 ? 'robots_unreachable' : null }).catch(() => undefined);
      const { status } = result;
      if (status >= 300 && status < 400 && result.location !== null) {
        if (hop + 1 > ROBOTS_MAX_REDIRECTS) return down('robots_too_many_redirects', status);
        let next: URL;
        try {
          next = new URL(result.location, url);
        } catch {
          return down('robots_bad_redirect', status);
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') return down('robots_bad_redirect', status);
        if (seen.has(next.href)) return down('robots_redirect_loop', status);
        seen.add(next.href);
        url = next.href;
        continue;
      }
      if (status >= 200 && status < 300) {
        return { kind: 'rules', origin, fetchedAt, status, file: parseRobots(result.body), truncated: result.truncated };
      }
      if (status === 429) return down('robots_http_429', status);
      if (status >= 400 && status < 500) return { kind: 'absent', origin, fetchedAt, status };
      if (status >= 500) return down('robots_http_5xx', status);
      return down('robots_unexpected_status', status);
    }
  }
}

function crawlDelayOf(group: SelectedGroup): number | null {
  if (group.crawlDelaySeconds === null) return null;
  return Math.min(MAX_CRAWL_DELAY_MS, Math.round(group.crawlDelaySeconds * 1000));
}

/** Lit au plus `max` octets d'un flux ; coupé, la dernière ligne (incomplète) est retirée. */
export async function readRobotsBody(stream: ReadableStream<Uint8Array> | null, max = ROBOTS_MAX_BYTES): Promise<{ body: string; truncated: boolean }> {
  if (stream === null) return { body: '', truncated: false };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  let body = Buffer.concat(chunks).toString('utf8');
  if (truncated) {
    const lastBreak = Math.max(body.lastIndexOf('\n'), body.lastIndexOf('\r'));
    body = lastBreak === -1 ? '' : body.slice(0, lastBreak + 1);
  }
  return { body, truncated };
}

/** Lecteur d'un saut de robots.txt par une session réseau (garde SSRF, barreau de l'essai, User-Agent du robot). */
export function sessionRobotsFetcher(session: Pick<NetworkSession, 'fetch'>): RobotsFetcher {
  return async (url, signal) => {
    const response = await session.fetch(url, { method: 'GET', headers: { accept: 'text/plain, */*;q=0.1' }, signal }, { followRedirects: false });
    const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
    if (location !== null || response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, location, body: '', truncated: false };
    }
    const { body, truncated } = await readRobotsBody(response.body as ReadableStream<Uint8Array> | null);
    return { status: response.status, location: null, body, truncated };
  };
}
