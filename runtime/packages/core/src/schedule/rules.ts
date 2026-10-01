// SPDX-License-Identifier: AGPL-3.0-only
// Règles d'une planification (08 § 5) : vocabulaire fermé, analyse stricte, décision pure. Sans I/O : la lecture du
// statut, du tunnel et des compteurs est faite par l'appelant (`@runtime/db`), la décision ici.
import type { ApiStatus } from '../model/enums.js';
import { API_STATUSES } from '../model/enums.js';
import type { SkippedRunState } from '../run/lifecycle.js';

export const SCHEDULE_OVERLAPS = ['skip', 'queue', 'allow'] as const;
export type ScheduleOverlap = (typeof SCHEDULE_OVERLAPS)[number];

export const SCHEDULE_MISSED = ['skip', 'once'] as const;
export type ScheduleMissed = (typeof SCHEDULE_MISSED)[number];

/**
 * Modes appliqués en V1 : `new` (seuls les items dont la clé n'a jamais été vue sont écrits) et `all` (tout est écrit,
 * les nouveautés sont comptées). `changed` et `removed` (08 § 5) demandent l'empreinte du contenu et la valeur des clés
 * disparues, que `dedup_keys` ne garde pas (seule l'empreinte HMAC de la clé y est, 17 § 6) : refusés à l'enregistrement
 * plutôt qu'acceptés sans effet.
 */
export const DIFF_MODES = ['new', 'all'] as const;
export type DiffMode = (typeof DIFF_MODES)[number];
const DIFF_MODES_NOT_YET = ['changed', 'removed'] as const;

export const ALERT_ON = ['new_items', 'status_change', 'error'] as const;
export type AlertOn = (typeof ALERT_ON)[number];

/** Défaut du CDC : on ne sollicite pas un site qui a refusé, ni une API qui attend une action de l'utilisateur. */
export const DEFAULT_SKIP_IF_STATUS_IN: readonly ApiStatus[] = ['erreur', 'action_requise', 'bloquee'];

/**
 * `bloquee` n'est jamais retirable (INV6, X4) : un site qui a refusé n'est pas re-sollicité par une planification.
 * La liste ne peut que s'allonger ; l'évaluateur l'impose même si une ligne écrite hors du service l'omet.
 */
export const ALWAYS_SKIPPED_STATUS: ApiStatus = 'bloquee';

/** Fenêtre horaire dans le fuseau de la planification, `HH:MM` ; `start > end` passe minuit. `end` exclu. */
export type TimeWindow = { start: string; end: string };

export type ScheduleRules = {
  only_if_tunnel_online: boolean;
  window: TimeWindow | null;
  max_runs_per_day: number | null;
  skip_if_status_in: readonly ApiStatus[];
  dedup_key: string | null;
  diff: DiffMode | null;
  alert_on: readonly AlertOn[] | null;
};

export type RulesParse = { ok: true; rules: ScheduleRules } | { ok: false; errors: string[] };

const KNOWN_KEYS = new Set(['only_if_tunnel_online', 'window', 'max_runs_per_day', 'skip_if_status_in', 'dedup_key', 'diff', 'alert_on']);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Nom de champ ou chemin pointé, jamais une expression. */
const DEDUP_KEY = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Analyse stricte : clé inconnue, type faux ou valeur hors vocabulaire = refus, avec chaque raison. */
export function parseScheduleRules(raw: unknown): RulesParse {
  const input = raw === undefined || raw === null ? {} : raw;
  if (!isRecord(input)) return { ok: false, errors: ['rules : objet attendu'] };
  const errors: string[] = [];
  for (const key of Object.keys(input)) if (!KNOWN_KEYS.has(key)) errors.push(`rules.${key} : règle inconnue`);

  let onlyIfTunnelOnline = false;
  if (input['only_if_tunnel_online'] !== undefined) {
    if (typeof input['only_if_tunnel_online'] === 'boolean') onlyIfTunnelOnline = input['only_if_tunnel_online'];
    else errors.push('rules.only_if_tunnel_online : booléen attendu');
  }

  let window: TimeWindow | null = null;
  if (input['window'] !== undefined && input['window'] !== null) {
    const w = input['window'];
    if (!isRecord(w) || typeof w['start'] !== 'string' || typeof w['end'] !== 'string' || !HHMM.test(w['start']) || !HHMM.test(w['end'])) {
      errors.push('rules.window : { start: "HH:MM", end: "HH:MM" } attendu');
    } else if (w['start'] === w['end']) {
      errors.push('rules.window : start et end identiques (fenêtre vide ou jour entier : retirer la règle)');
    } else {
      window = { start: w['start'], end: w['end'] };
    }
  }

  let maxRunsPerDay: number | null = null;
  if (input['max_runs_per_day'] !== undefined && input['max_runs_per_day'] !== null) {
    const n = input['max_runs_per_day'];
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 100_000) maxRunsPerDay = n;
    else errors.push('rules.max_runs_per_day : entier entre 1 et 100000 attendu');
  }

  let skip: ApiStatus[] = [...DEFAULT_SKIP_IF_STATUS_IN];
  if (input['skip_if_status_in'] !== undefined) {
    const list = input['skip_if_status_in'];
    if (!Array.isArray(list) || list.some((s) => typeof s !== 'string' || !(API_STATUSES as readonly string[]).includes(s))) {
      errors.push(`rules.skip_if_status_in : liste de statuts parmi ${API_STATUSES.join(', ')} attendue`);
    } else if (!list.includes(ALWAYS_SKIPPED_STATUS)) {
      errors.push(`rules.skip_if_status_in : « ${ALWAYS_SKIPPED_STATUS} » ne peut pas être retiré (on ne re-sollicite pas un site qui a refusé)`);
    } else {
      skip = [...new Set(list as ApiStatus[])];
    }
  }

  let dedupKey: string | null = null;
  if (input['dedup_key'] !== undefined && input['dedup_key'] !== null) {
    const k = input['dedup_key'];
    if (typeof k === 'string' && DEDUP_KEY.test(k) && k.length <= 128) dedupKey = k;
    else errors.push('rules.dedup_key : nom de champ (ou chemin pointé) attendu');
  }

  let diff: DiffMode | null = null;
  if (input['diff'] !== undefined && input['diff'] !== null) {
    const d = input['diff'];
    if (typeof d === 'string' && (DIFF_MODES as readonly string[]).includes(d)) diff = d as DiffMode;
    else if (typeof d === 'string' && (DIFF_MODES_NOT_YET as readonly string[]).includes(d)) errors.push(`rules.diff « ${d} » : pas encore pris en charge (V1 : ${DIFF_MODES.join(' | ')})`);
    else errors.push(`rules.diff : ${DIFF_MODES.join(' | ')} attendu`);
  }
  if (diff !== null && diff !== 'all' && dedupKey === null) errors.push(`rules.diff « ${diff} » exige rules.dedup_key`);

  let alertOn: AlertOn[] | null = null;
  if (input['alert_on'] !== undefined && input['alert_on'] !== null) {
    const a = input['alert_on'];
    if (!Array.isArray(a) || a.some((x) => typeof x !== 'string' || !(ALERT_ON as readonly string[]).includes(x))) {
      errors.push(`rules.alert_on : liste parmi ${ALERT_ON.join(', ')} attendue`);
    } else alertOn = [...new Set(a as AlertOn[])];
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    rules: {
      only_if_tunnel_online: onlyIfTunnelOnline,
      window,
      max_runs_per_day: maxRunsPerDay,
      skip_if_status_in: skip,
      dedup_key: dedupKey,
      diff,
      alert_on: alertOn,
    },
  };
}

/** Heure locale `HH:MM` et date locale `YYYY-MM-DD` d'un instant dans un fuseau IANA. */
export function localParts(at: Date, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

export function inWindow(window: TimeWindow, at: Date, timezone: string): boolean {
  const { time } = localParts(at, timezone);
  return window.start < window.end ? time >= window.start && time < window.end : time >= window.start || time < window.end;
}

export type RuleContext = {
  now: Date;
  timezone: string;
  enabled: boolean;
  overlap: ScheduleOverlap;
  apiStatus: ApiStatus;
  /** Une extension appairée est connectée pour le propriétaire (lue seulement si la règle ou `requires.tunnel` l'exige). */
  tunnelOnline: boolean;
  /** `requires.tunnel` de l'API : le tunnel est alors exigé même sans la règle (04b : `skipped_tunnel_offline`). */
  apiRequiresTunnel: boolean;
  /** Runs réellement lancés par cette planification sur le jour du fuseau (hors `skipped_*`). */
  runsToday: number;
  /** Un run de cette planification est encore actif (`queued`, `running`, `waiting_tunnel`). */
  activeRun: boolean;
};

export type RuleDecision =
  | { action: 'run' }
  /** Planification désactivée : le job se termine, aucun run n'est tracé. */
  | { action: 'ignore'; reason: 'disabled' }
  | { action: 'skip'; state: SkippedRunState; reason: string }
  /** `overlap: queue` : le run attend la fin du précédent (le job est remis plus tard). */
  | { action: 'defer'; reason: 'overlap' };

/** Ordre : statut (on ne sollicite pas un site qui a refusé), tunnel, fenêtre, quota, chevauchement. */
export function evaluateScheduleRules(rules: ScheduleRules, ctx: RuleContext): RuleDecision {
  if (!ctx.enabled) return { action: 'ignore', reason: 'disabled' };
  if (ctx.apiStatus === ALWAYS_SKIPPED_STATUS || rules.skip_if_status_in.includes(ctx.apiStatus)) {
    return { action: 'skip', state: 'skipped_status', reason: `status_${ctx.apiStatus}` };
  }
  if ((rules.only_if_tunnel_online || ctx.apiRequiresTunnel) && !ctx.tunnelOnline) {
    return { action: 'skip', state: 'skipped_tunnel_offline', reason: 'tunnel_offline' };
  }
  if (rules.window !== null && !inWindow(rules.window, ctx.now, ctx.timezone)) {
    return { action: 'skip', state: 'skipped_window', reason: 'outside_window' };
  }
  if (rules.max_runs_per_day !== null && ctx.runsToday >= rules.max_runs_per_day) {
    return { action: 'skip', state: 'skipped_quota', reason: 'max_runs_per_day' };
  }
  if (ctx.activeRun) {
    if (ctx.overlap === 'skip') return { action: 'skip', state: 'skipped_overlap', reason: 'previous_run_active' };
    if (ctx.overlap === 'queue') return { action: 'defer', reason: 'overlap' };
  }
  return { action: 'run' };
}
