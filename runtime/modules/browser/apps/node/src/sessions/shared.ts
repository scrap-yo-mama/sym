// SPDX-License-Identifier: AGPL-3.0-only
// Sessions shared du nœud (cdc/sym-browser 04b § 1, 04c § 3.1, tâche 1.3) : chaque session reçoit un contexte Playwright
// NEUF (en mémoire : cookies, stockage, IndexedDB, cache, onglets) dans un Chromium chaud réservé à son client (pool,
// tâche 1.1), avec ses options (viewport, locale, fuseau, UA, en-têtes, géolocalisation, thème). Le contexte appartient à la
// connexion interne du nœud : une déconnexion du client ne le ferme pas (reprise : tâche 2.3).
// Fin : le contexte est fermé AVANT que le slot soit rendu ; à la dernière session du client, le pool détruit le Chromium
// (un Chromium ne sert jamais deux clients, BINV1). Le pool peut aussi imposer la fin (plantage, chien de garde, arrêt).
// Protocole servi : Playwright natif seulement (`protocols.ts`). Les états de session (`pending → running → …`) et leur
// persistance viennent de la tâche 1.2 : `onEnd` en est le point d'accroche.
// Enregistrements (tâche 3.3, 04d § 2) : avec `recorder` et `dataDir`, les enregistrements demandés sont produits par le
// nœud sur le contexte de la session dans `sessions/{id}/recordings`, arrêtés et déposés chiffrés AVANT la fermeture du
// contexte ; le répertoire `sessions/{id}` est supprimé avant que le slot soit rendu.
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { EndReason, RecordingOptions } from '@sym/contracts/browser';
import type { BrowserContext } from 'playwright-core';
import { sessionDir, type SessionDir } from '../dedicated/dedicated.js';
import type { AcquireRequest, LeaseEndReason, PoolLease } from '../pool/index.js';
import { anyRecording, recordingOptions } from '../recordings/options.js';
import type { ActiveRecording, SessionRecorder } from '../recordings/recorder.js';
import type { LiveViews } from '../live/live-views.js';
import { InvalidSessionOptionError, sharedContextOptions, type SharedSessionInput } from './options.js';
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
  /** `SYMB_DATA_DIR` : répertoire `sessions/{id}` de chaque session (enregistrements). */
  dataDir?: string;
  /** Enregistrements des sessions (tâche 3.3) ; exige `dataDir`. */
  recorder?: SessionRecorder;
  /** Vues en direct (tâche 3.2) : une par session, ouverte à la création, fermée en tête de la destruction. */
  liveViews?: LiveViews;
};

export type CreateSharedSession = {
  sessionId: string;
  tenantId: string;
  options: SharedSessionInput;
  /** Chien de garde de la session (`expiresAt`, tâche 1.2). */
  watchdogMs?: number;
  /** Egress de la session (tâche 1.5). */
  egressProxyUrl?: string;
  /** Option `recordings` de la session (04d § 2.1). */
  recordings?: RecordingOptions;
  /** Option `liveView` de la session (04 § 3) : `interactive` permet les entrées d'un visionneur au jeton `rw`. */
  liveView?: { interactive?: boolean };
};

type State = { session: SharedSession; lease: PoolLease; dir: SessionDir | undefined; recording: ActiveRecording | undefined; ending: Promise<void> | null; reason: SharedEndReason | null };

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
    const live = request.liveView as unknown;
    if (live !== undefined && (typeof live !== 'object' || live === null || Array.isArray(live) || Object.keys(live).some((k) => k !== 'interactive') || ((live as { interactive?: unknown }).interactive !== undefined && typeof (live as { interactive?: unknown }).interactive !== 'boolean'))) {
      throw new InvalidSessionOptionError([{ field: 'liveView', reason: 'objet {interactive: booléen} attendu' }]);
    }
    const recordings = recordingOptions(request.recordings);
    const recording = anyRecording(recordings);
    if (recording && (this.#options.recorder === undefined || this.#options.dataDir === undefined)) throw new RangeError('enregistrements demandés : recorder et dataDir requis sur ce nœud');
    const dir = this.#options.dataDir === undefined ? undefined : sessionDir(this.#options.dataDir, request.sessionId);
    if (this.#sessions.has(request.sessionId) || this.#creating.has(request.sessionId)) throw new RangeError(`session ${request.sessionId} déjà présente sur ce nœud`);
    this.#creating.add(request.sessionId);
    try {
      const acquire: AcquireRequest = { sessionId: request.sessionId, type: 'shared', tenantId: request.tenantId };
      if (request.watchdogMs !== undefined) acquire.watchdogMs = request.watchdogMs;
      const lease = await this.#options.pool.acquire(acquire);
      let context: BrowserContext | undefined;
      let active: ActiveRecording | undefined;
      let created = false;
      try {
        if (dir !== undefined && recording) {
          await mkdir(join(dir.root, '..'), { recursive: true, mode: 0o700 });
          // Répertoire neuf : un répertoire déjà présent (identifiant réutilisé, destruction inachevée) est refusé.
          await mkdir(dir.root, { mode: 0o700 });
          created = true;
        }
        context = await lease.browser.newContext(contextOptions);
        if (recording && dir !== undefined) active = await this.#options.recorder!.start({ sessionId: request.sessionId, tenantId: request.tenantId, context, workDir: join(dir.root, 'recordings'), options: request.recordings });
      } catch (error) {
        await context?.close().catch(() => undefined);
        if (created && dir !== undefined) await rm(dir.root, { recursive: true, force: true });
        await lease.release();
        throw error;
      }
      if (this.#options.liveViews !== undefined && context !== undefined) this.#options.liveViews.open({ sessionId: request.sessionId, context, interactive: request.liveView?.interactive === true });
      const state: State = { session: undefined as unknown as SharedSession, lease, dir: created ? dir : undefined, recording: active, ending: null, reason: null };
      state.session = {
        sessionId: request.sessionId,
        tenantId: request.tenantId,
        type: 'shared',
        browserId: lease.browserId,
        wsEndpoint: lease.wsEndpoint,
        context: context!,
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
      // Enregistrements arrêtés et déposés tant que le contexte vit (étape 5 de la destruction, 04c § 3.2).
      // Visionneurs prévenus ({t: closed}) et screencasts arrêtés en premier : plus aucune entrée n'atteint la session.
      await this.#options.liveViews?.close(state.session.sessionId, reason).catch(() => undefined);
      await state.recording?.stop().catch(() => undefined);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        state.session.context.close().catch(() => undefined),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, this.#options.closeTimeoutMs ?? 10_000))),
      ]);
      clearTimeout(timer);
      if (state.dir !== undefined) await rm(state.dir.root, { recursive: true, force: true });
      await state.lease.release();
      this.#options.onEnd?.({ sessionId: state.session.sessionId, tenantId: state.session.tenantId, reason });
    })();
    return state.ending;
  }
}
