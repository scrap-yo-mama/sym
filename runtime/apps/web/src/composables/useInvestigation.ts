// SPDX-License-Identifier: AGPL-3.0-only
// Enquête en direct (06 § 2, « Nouvelle API ») : création de l'API, suivi par le flux SSE de l'onglet, Pause, Reprise,
// Arrêt, validation du schéma et ré-enquête. L'état est rangé par `lib/investigation.ts` ; ce composable ne décide de rien
// (06 § 4.1) : chaque bouton appelle une route du serveur et l'écran suit ce que le serveur annonce.
import type { components } from '@runtime/client';
import { computed, onScopeDispose, reactive, readonly, ref } from 'vue';
import { call, type CallResult } from '@/lib/api-call';
import { getApi } from '@/lib/api';
import {
  emptyInvestigation,
  hostOf,
  ingestEvent,
  seedFromCreated,
  seedFromRun,
  type Execution,
  type InvestigationState,
} from '@/lib/investigation';
import { EventStreamClient, type SseEvent } from '@/lib/sse';
import { useEventStream } from '@/composables/useEventStream';
import { can, markExpired } from '@/composables/useSession';

type Schemas = components['schemas'];
export type ApiCreateBody = Schemas['ApiCreate'];

/** Action de contrôle en cours (un seul bouton est occupé à la fois). */
export type Busy = 'create' | 'pause' | 'resume' | 'cancel' | 'validate' | 'reinvestigate' | null;

export interface InvestigationOptions {
  /** Flux filtré d'un run (rejeu depuis le début à la réouverture) ; injectable pour les tests. */
  replayFactory?: (runId: string) => EventStreamClient;
  now?: () => number;
}

/** Au plus autant d'événements gardés avant que l'identifiant du run soit connu (course entre la réponse et le flux). */
const BUFFER_LIMIT = 500;

/**
 * Message d'un refus : `instance_contact_missing` (UX-04) dit quoi faire selon les droits, renseigner le contact du robot
 * (admin, owner) ou le demander à un admin (membre, qui ne voit pas le bandeau) ; les autres codes gardent leur message.
 */
function contactAwareKey(result: { code: string | null; messageKey: string }): string {
  if (result.code !== 'instance_contact_missing') return result.messageKey;
  return can('settings:identity:write') ? 'errors.instance_contact_missing' : 'errors.instance_contact_missing_member';
}

export function useInvestigation(options: InvestigationOptions = {}) {
  const now = options.now ?? Date.now;
  const replayFactory = options.replayFactory ?? ((runId: string) => new EventStreamClient({ url: `/api/runs/${encodeURIComponent(runId)}/events` }));
  const state = reactive<InvestigationState>(emptyInvestigation());
  const busy = ref<Busy>(null);
  /** Pause demandée par l'utilisateur (la reprise est son action, jamais celle d'une vérification). */
  const paused = ref(false);
  /** Clé i18n de la dernière erreur d'action, sinon null. */
  const failure = ref<string | null>(null);
  /** Résultat d'un arrêt : coût conservé. */
  const cancelled = ref(false);
  const tick = ref(now());
  const buffer: SseEvent[] = [];
  let replay: EventStreamClient | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let waitingForRun = false;

  const { onStreamEvent } = useEventStream();
  const unsubscribe = onStreamEvent(onEvent);

  function onEvent(event: SseEvent): void {
    if (!state.runId && !state.apiId) {
      if (waitingForRun && buffer.length < BUFFER_LIMIT) buffer.push(event);
      return;
    }
    ingestEvent(state, event, now());
    if (state.terminal) stopClock();
  }

  function startClock(): void {
    if (timer) return;
    timer = setInterval(() => {
      tick.value = now();
    }, 1000);
  }

  function stopClock(): void {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function flushBuffer(): void {
    waitingForRun = false;
    const pending = buffer.splice(0, buffer.length);
    for (const event of pending) ingestEvent(state, event, now());
  }

  /** Secondes écoulées affichées : la valeur du serveur plus le temps passé depuis sa réception (arrêtée en pause ou à la fin). */
  const elapsedS = computed(() => {
    const budget = state.budget;
    if (!budget || budget.elapsedS === null) return null;
    const running = !paused.value && !state.terminal && !cancelled.value;
    const extra = running ? Math.max(0, (tick.value - budget.receivedAtMs) / 1000) : 0;
    const total = budget.elapsedS + extra;
    return budget.timeoutS === null ? total : Math.min(total, budget.timeoutS);
  });

  /** L'enquête est suivie (run connu) et pas encore finie. */
  const active = computed(() => state.runId !== null && !state.terminal && !cancelled.value);

  function track(): void {
    startClock();
  }

  /** Crée l'API et lance l'enquête (POST /api/apis, sans attente : l'écran suit le flux). */
  async function create(body: ApiCreateBody): Promise<CallResult<unknown>> {
    busy.value = 'create';
    failure.value = null;
    waitingForRun = true;
    buffer.length = 0;
    Object.assign(state, emptyInvestigation(), { domain: hostOf(body.url), description: body.description.trim() || null });
    const result = await call<unknown>(() => getApi().POST('/api/apis', { params: { query: { wait: 0 } }, body }));
    busy.value = null;
    if (!result.ok) {
      waitingForRun = false;
      const refused = { ...result, messageKey: contactAwareKey(result) };
      failure.value = refused.messageKey;
      return refused;
    }
    const data = result.data;
    const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    if ('api_id' in record) {
      seedFromCreated(state, record);
    } else if (typeof record.run_id === 'string') {
      state.runId = record.run_id;
    }
    if (state.runId && !state.slug) await loadRun(state.runId);
    if ('status' in record && 'timeline' in record) state.terminal = true; // `auto_validate` : l'enquête est déjà finie (RunResult)
    flushBuffer();
    if (!state.terminal) track();
    return result;
  }

  async function loadRun(runId: string): Promise<boolean> {
    const result = await call<unknown>(() => getApi().GET('/api/runs/{id}', { params: { path: { id: runId } } }));
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    seedFromRun(state, result.data as Record<string, unknown>, now());
    // La pause est relue du serveur (`paused_at` du Run) : elle survit au rechargement de la page.
    paused.value = state.pausedAt !== null;
    return true;
  }

  /** Rouvre une enquête existante : état relu, puis journal rejoué depuis le début par le flux filtré du run. */
  async function open(runId: string): Promise<boolean> {
    failure.value = null;
    Object.assign(state, emptyInvestigation());
    state.runId = runId;
    paused.value = false;
    const loaded = await loadRun(runId);
    if (!loaded) return false;
    replay?.stop();
    replay = replayFactory(runId);
    replay.onEvent((event) => {
      ingestEvent(state, event, now());
      if (state.terminal) {
        stopClock();
        replay?.stop();
      }
    });
    replay.onUnauthorized(markExpired);
    replay.start();
    if (!state.terminal) track();
    return true;
  }

  async function control(kind: 'pause' | 'resume' | 'cancel'): Promise<boolean> {
    const runId = state.runId;
    if (!runId || busy.value) return false;
    busy.value = kind;
    failure.value = null;
    const path = { params: { path: { id: runId } } };
    const result =
      kind === 'pause'
        ? await call<unknown>(() => getApi().POST('/api/runs/{id}/pause', path))
        : kind === 'resume'
          ? await call<unknown>(() => getApi().POST('/api/runs/{id}/resume', path))
          : await call<unknown>(() => getApi().POST('/api/runs/{id}/cancel', path));
    busy.value = null;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    if (kind === 'pause') paused.value = true;
    if (kind === 'resume') {
      paused.value = false;
      tick.value = now();
    }
    if (kind === 'cancel') {
      cancelled.value = true;
      state.terminal = true;
      stopClock();
      replay?.stop();
    }
    return true;
  }

  /** « Valider » (ou « Modifier » puis valider) le schéma de sortie proposé ; le plan d'essais peut être restreint. */
  async function validate(input: { outputSchema?: Record<string, unknown>; excludeExecutions?: Execution[] } = {}): Promise<boolean> {
    const apiId = state.apiId;
    if (!apiId || busy.value) return false;
    busy.value = 'validate';
    failure.value = null;
    const body: Schemas['ValidateSchemaRequest'] = { wait_seconds: 0 };
    if (input.outputSchema) body.output_schema = input.outputSchema;
    if (input.excludeExecutions && input.excludeExecutions.length > 0) body.exclude_executions = input.excludeExecutions;
    const result = await call<unknown>(() => getApi().POST('/api/apis/{id}/validate-schema', { params: { path: { id: apiId }, query: { wait: 0 } }, body }));
    busy.value = null;
    if (!result.ok) {
      failure.value = result.messageKey;
      return false;
    }
    const record = typeof result.data === 'object' && result.data !== null ? (result.data as Record<string, unknown>) : {};
    if (typeof record.run_id === 'string' && !state.runId) state.runId = record.run_id;
    state.phase = 'testing';
    track();
    return true;
  }

  /** « Ré-enquêter » (seule reprise offerte à une API bloquée, transition 18) : action manuelle de l'utilisateur, corps vide (InvestigateRequest). */
  async function reinvestigate(): Promise<boolean> {
    const slug = state.slug;
    if (!slug || busy.value) return false;
    busy.value = 'reinvestigate';
    failure.value = null;
    const result = await call<unknown>(() => getApi().POST('/api/apis/{slug}/investigate', { params: { path: { slug } }, body: {} }));
    busy.value = null;
    if (!result.ok) {
      failure.value = contactAwareKey(result);
      return false;
    }
    const record = typeof result.data === 'object' && result.data !== null ? (result.data as Record<string, unknown>) : {};
    const next = typeof record.run_id === 'string' ? record.run_id : null;
    Object.assign(state, emptyInvestigation(), { slug, apiId: state.apiId, domain: state.domain, runId: next });
    paused.value = false;
    cancelled.value = false;
    if (next) await open(next);
    return true;
  }

  function dispose(): void {
    unsubscribe();
    stopClock();
    replay?.stop();
    replay = null;
  }
  onScopeDispose(dispose);

  return {
    state: readonly(state) as Readonly<InvestigationState>,
    busy: readonly(busy),
    paused: readonly(paused),
    cancelled: readonly(cancelled),
    failure: readonly(failure),
    elapsedS,
    active,
    create,
    open,
    pause: () => control('pause'),
    resume: () => control('resume'),
    cancel: () => control('cancel'),
    validate,
    reinvestigate,
    /** Applique un événement à la main (tests, rejeu). */
    ingest: onEvent,
    dispose,
  };
}
