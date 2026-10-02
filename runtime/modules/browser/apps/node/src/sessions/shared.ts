// SPDX-License-Identifier: AGPL-3.0-only
// Sessions shared du nœud (cdc/sym-browser 04b § 1, 04c § 3.1, tâche 1.3) : chaque session reçoit un contexte Playwright
// NEUF (en mémoire : cookies, stockage, IndexedDB, cache, onglets) dans un Chromium chaud réservé à son client (pool,
// tâche 1.1), avec ses options (viewport, locale, fuseau, UA, en-têtes, géolocalisation, thème). Le contexte appartient à la
// connexion interne du nœud : une déconnexion du client ne le ferme pas (reprise : tâche 2.3).
// Fin : le contexte est fermé AVANT que le slot soit rendu ; à la dernière session du client, le pool détruit le Chromium
// (un Chromium ne sert jamais deux clients, BINV1). Le pool peut aussi imposer la fin (plantage, chien de garde, arrêt).
// Protocole servi : Playwright natif seulement (`protocols.ts`). Les états de session (`pending → running → …`) et leur
// persistance viennent de la tâche 1.2 : `onEnd` en est le point d'accroche.
import type { EndReason } from '@sym/contracts/browser';
import type { BrowserContext } from 'playwright-core';
import type { AcquireRequest, LeaseEndReason, PoolLease } from '../pool/index.js';
import { sharedContextOptions, type SharedSessionInput } from './options.js';
import { servedProtocols, type SessionProtocol } from './protocols.js';

/** Fins possibles d'une session shared vues par le nœud (sous-ensemble de `EndReason`). */
export type SharedEndReason = Extract<EndReason, 'released' | 'crash' | 'timeout' | 'node_shutdown'>;
export type SharedSessionEnd = { sessionId: string; tenantId: string; reason: SharedEndReason };

const FROM_POOL: Record<LeaseEndReason, SharedEndReason> = { crash: 'crash', timed_out: 'timeout', shutdown: 'node_shutdown' };

export type SharedSession = {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly type: 'shared';
  readonly browserId: string;
  /** WebSocket Playwright local du Chromium porteur (relais de la tâche 2.3). */
  readonly wsEndpoint: string;
  readonly context: BrowserContext;
  readonly protocols: Record<SessionProtocol, boolean>;
  /** `null` tant que la session vit. */
  readonly endReason: SharedEndReason | null;
  /** Libération (`released`) : contexte fermé, puis slot rendu. Idempotent. */
  release(): Promise<void>;
};

export type SharedSessionsOptions = {
  pool: { acquire(request: AcquireRequest): Promise<PoolLease> };
  /** Délai de fermeture d'un contexte ; au-delà, le slot est rendu (le pool ferme ou tue le Chromium à son délai dur). */
  closeTimeoutMs?: number;
  onEnd?: (end: SharedSessionEnd) => void;
};

export type CreateSharedSession = {
  sessionId: string;
  tenantId: string;
  options: SharedSessionInput;
  /** Chien de garde de la session (`expiresAt`, tâche 1.2). */
  watchdogMs?: number;
  /** Egress de la session (tâche 1.5). */
  egressProxyUrl?: string;
};

type State = { session: SharedSession; lease: PoolLease; ending: Promise<void> | null; reason: SharedEndReason | null };

export class SharedSessions {
  readonly #options: SharedSessionsOptions;
  readonly #sessions = new Map<string, State>();
  /** Identifiants réservés pendant la création (deux créations simultanées du même id). */
  readonly #creating = new Set<string>();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(options: SharedSessionsOptions) {
    this.#options = options;
  }

  get(sessionId: string): SharedSession | undefined {
    return this.#sessions.get(sessionId)?.session;
  }

  /** Attend la fin des terminaisons en cours (fins imposées par le pool). */
  async whenIdle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  async create(request: CreateSharedSession): Promise<SharedSession> {
    // Validation d'abord : une option invalide ne réserve aucun slot.
    const contextOptions = sharedContextOptions(request.options, request.egressProxyUrl === undefined ? {} : { egressProxyUrl: request.egressProxyUrl });
    if (this.#sessions.has(request.sessionId) || this.#creating.has(request.sessionId)) throw new RangeError(`session ${request.sessionId} déjà présente sur ce nœud`);
    this.#creating.add(request.sessionId);
    try {
      const acquire: AcquireRequest = { sessionId: request.sessionId, type: 'shared', tenantId: request.tenantId };
      if (request.watchdogMs !== undefined) acquire.watchdogMs = request.watchdogMs;
      const lease = await this.#options.pool.acquire(acquire);
      let context: BrowserContext;
      try {
        context = await lease.browser.newContext(contextOptions);
      } catch (error) {
        await lease.release();
        throw error;
      }
      const state: State = { session: undefined as unknown as SharedSession, lease, ending: null, reason: null };
      state.session = {
        sessionId: request.sessionId,
        tenantId: request.tenantId,
        type: 'shared',
        browserId: lease.browserId,
        wsEndpoint: lease.wsEndpoint,
        context,
        protocols: servedProtocols('shared'),
        get endReason() {
          return state.reason;
        },
        release: () => this.#end(state, 'released'),
      };
      this.#sessions.set(request.sessionId, state);
      const onAbort = (): void => {
        const work = this.#end(state, FROM_POOL[lease.signal.reason as LeaseEndReason] ?? 'crash');
        const tracked = work.finally(() => this.#pending.delete(tracked));
        this.#pending.add(tracked);
      };
      if (lease.signal.aborted) onAbort();
      else lease.signal.addEventListener('abort', onAbort, { once: true });
      return state.session;
    } finally {
      this.#creating.delete(request.sessionId);
    }
  }

  /** Fin unique : contexte fermé (à délai), slot rendu, fin signalée. */
  #end(state: State, reason: SharedEndReason): Promise<void> {
    state.ending ??= (async () => {
      state.reason = reason;
      this.#sessions.delete(state.session.sessionId);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        state.session.context.close().catch(() => undefined),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, this.#options.closeTimeoutMs ?? 10_000))),
      ]);
      clearTimeout(timer);
      await state.lease.release();
      this.#options.onEnd?.({ sessionId: state.session.sessionId, tenantId: state.session.tenantId, reason });
    })();
    return state.ending;
  }
}
