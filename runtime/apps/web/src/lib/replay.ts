// SPDX-License-Identifier: AGPL-3.0-only
// Replay d'enquête (06 § 2, onglet Enquêtes) : événements de `investigation_events` reçus par le flux filtré
// `GET /api/runs/{id}/events`. Ce module ne contient que la lecture des trames et le calcul des délais ; le texte affiché
// vient de `replay.kinds.<kind>` (codes stables, 06 § 4.1) et les charges ne sont jamais interprétées comme du HTML.
import type { SseEvent } from '@/lib/sse';

export type ReplayEvent = {
  id: string | null;
  seq: number;
  /** Nom d'événement (`phase.started`, `attempt.finished`, `access_report`…). */
  kind: string;
  at: string | null;
  /** Paramètres scalaires de la charge (nombres et textes) pour la phrase ; le reste de la charge est ignoré à l'affichage. */
  params: Record<string, string | number>;
};

export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** Pause maximale entre deux événements avant mise à l'échelle : un enquête qui a attendu 40 s ne fige pas le replay. */
const MAX_GAP_MS = 3_000;
const MIN_GAP_MS = 60;

function scalarParams(payload: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (typeof payload !== 'object' || payload === null) return out;
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}

/** Trame SSE → événement de replay ; une trame illisible (JSON invalide, sans nom) donne null. */
export function parseReplayEvent(frame: SseEvent, fallbackSeq: number): ReplayEvent | null {
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const body = data as Record<string, unknown>;
  const kind = typeof body.kind === 'string' ? body.kind : frame.event;
  if (kind === '' || kind === 'message') return null;
  return {
    id: frame.id,
    seq: typeof body.seq === 'number' ? body.seq : fallbackSeq,
    kind,
    at: typeof body.at === 'string' ? body.at : null,
    params: scalarParams(body.payload),
  };
}

/** Attente avant d'afficher l'événement `index`, selon la vitesse (0,5x à 4x). Le premier s'affiche tout de suite. */
export function delayBefore(events: readonly ReplayEvent[], index: number, speed: number): number {
  const current = events[index];
  const previous = events[index - 1];
  if (!current || !previous || !current.at || !previous.at) return index === 0 ? 0 : MIN_GAP_MS / speed;
  const gap = Date.parse(current.at) - Date.parse(previous.at);
  const bounded = Number.isFinite(gap) ? Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, gap)) : MIN_GAP_MS;
  return bounded / speed;
}

/** Index des débuts de phase, pour le saut de phase en phase. */
export function phaseStarts(events: readonly ReplayEvent[]): { index: number; phase: string }[] {
  const out: { index: number; phase: string }[] = [];
  events.forEach((event, index) => {
    if (event.kind === 'phase.started') out.push({ index, phase: String(event.params.phase ?? '') });
  });
  return out;
}

/** Paramètres de charge dont la valeur est un code traduit : clé du paramètre → préfixe i18n. */
const SCOPES: Record<string, string> = { execution: 'execution', network: 'network', phase: 'replay.phases', status: 'status', from: 'status', to: 'status' };

type Translate = (key: string, named?: Record<string, string>) => string;
type Exists = (key: string) => boolean;

/** Clé plate d'un nom d'événement : les points et caractères hors `[a-z0-9_]` deviennent `_` (`phase.started` → `phase_started`). */
export function replayKindKey(kind: string): string {
  return `replay.kinds.${kind.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
}

/**
 * Phrase d'un événement du replay. Les valeurs de la charge sont des paramètres de texte (jamais du HTML) ; exécution,
 * réseau, phase et statut sont traduits quand le code est connu, sinon affichés tels quels.
 */
export function describeReplayEvent(t: Translate, te: Exists, event: ReplayEvent): string {
  const named: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.params)) {
    const text = String(value);
    const scope = SCOPES[key] ?? null;
    named[key] = scope && te(`${scope}.${text}`) ? t(`${scope}.${text}`) : text;
  }
  const key = replayKindKey(event.kind);
  return te(key) ? t(key, named) : t('replay.kinds.unknown', { kind: event.kind });
}
