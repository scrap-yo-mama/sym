// SPDX-License-Identifier: AGPL-3.0-only
// Chronologie d'une enquête (tâche 3.10, 05 § 1.2) : `timeline[]` de l'enveloppe RunResult, dérivée de la SEULE source
// `investigation_events` (03 : la progression MCP, le SSE de la console et le replay en dérivent aussi). Fonction pure sur
// les événements : aucun texte du site n'y entre (codes, comptes, coûts, durées). Le récit MCP (`mcp/narrative.ts`) rend ces
// mêmes entrées en texte : le texte et `structuredContent` citent donc les mêmes essais et les mêmes coûts
// (`assert_narrative_matches_structured`).
import { INVESTIGATION_EVENTS as EV } from '@runtime/core/investigation';
import { withActor } from '@runtime/db';
import type pg from 'pg';
import type { ServerContext } from '../context.js';
import type { Actor } from '../routes/guard.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export type EventRow = { seq: number; kind: string; payload: unknown; at: Date };

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/** Forme d'un code du worker (cause, classe d'échec, résultat, mode, phase, chemin) : liste fermée, jamais un texte. */
const CODE = /^[a-z][a-z0-9_]{0,39}$/;
/** Nom d'hôte en minuscules (domaine de l'enquête), sans port ni chemin. */
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Code présent : lui-même s'il a la forme d'un code, sinon `unknown` (jamais le texte reçu). */
export const codeOf = (v: unknown): string => (typeof v === 'string' && CODE.test(v) ? v : 'unknown');
/** Code facultatif : `null` s'il est absent, `unknown` s'il n'a pas la forme d'un code. */
export const codeOrNull = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : codeOf(v));
/** Domaine : le nom d'hôte s'il en a la forme, sinon `null`. */
export const hostOrNull = (v: unknown): string | null => (typeof v === 'string' && HOST.test(v) ? v : null);

/** Premier élément de la chronologie : l'enquête elle-même (API, domaine, phase courante). */
type TimelineStart = { kind: 'investigation'; step: 0; slug: string; domain: string | null; phase: string };
/** Rapport d'accès (D-91 : plus de section robots.txt) : la pastille `allowed` ou `review`, sinon null (événement ancien). */
export type TimelineAccess = { kind: 'access_report'; step: number; signal: 'allowed' | 'review' | null; cost_usd: number; ms: number };
export type TimelineRecon = { kind: 'reconnaissance'; step: number; mode: string | null; sources: number; failure_class: string | null; cost_usd: number; ms: number };
type TimelineSchema = { kind: 'schema'; step: null; ok: boolean; fields: number | null };
export type TimelineAttempt = {
  kind: 'attempt';
  step: number;
  execution: string;
  network: string;
  result: string;
  records: number | null;
  pages: number | null;
  est_cost_usd: number | null;
  cost_usd: number;
  ms: number | null;
};
type TimelinePruned = { kind: 'pruned'; step: null; by: { execution: string; network: string } | null; reason: string | null; count: number };
type TimelineAction = { kind: 'action_required'; step: null; cause: string };
export type TimelineFinished = {
  kind: 'finished';
  step: null;
  outcome: string;
  strategy: { version: number | null; execution: string; network: string; est_cost_usd: number | null } | null;
  items: number | null;
  stop_reason: string | null;
  failure_class: string | null;
};
export type TimelineEntry = TimelineStart | TimelineAccess | TimelineRecon | TimelineSchema | TimelineAttempt | TimelinePruned | TimelineAction | TimelineFinished;

/** Phase courante d'une enquête, d'après ses événements (codes de `phase.started`, `done`, `stopped`, `failed`). */
function phaseOf(events: readonly EventRow[]): string {
  let phase = 'investigating';
  for (const e of events) {
    const p = rec(e.payload);
    if (e.kind === EV.started) phase = str(p['phase']) ?? phase;
    else if (e.kind === EV.phase) phase = str(p['phase']) ?? phase;
    else if (e.kind === EV.finished) {
      const outcome = str(p['outcome']);
      phase = outcome === 'conformant' ? 'done' : outcome === 'stopped' ? 'stopped' : outcome === 'budget_exhausted' ? 'budget_exhausted' : 'failed';
    }
  }
  return phase;
}

/**
 * `timeline[]` d'une enquête : l'entrée de tête, puis une entrée par étape (rapport d'accès, reconnaissance, essai) et par
 * jalon (schéma proposé, élagage, action requise, fin). Les étapes numérotées (`step`, à partir de 1) sont celles du récit.
 * Coût d'une étape : celui de l'essai quand il est connu, sinon l'écart de dépense (`budget.spent_usd`) depuis l'événement
 * précédent ; durée : celle de l'essai, sinon l'écart d'horodatage avec l'événement précédent.
 */
export function buildTimeline(events: readonly EventRow[], slug: string): TimelineEntry[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const first = sorted.find((e) => e.kind === EV.started);
  const out: TimelineEntry[] = [{ kind: 'investigation', step: 0, slug, domain: hostOrNull(rec(first?.payload)['domain']), phase: codeOf(phaseOf(sorted)) }];
  let step = 0;
  let spent = 0;
  let previousAt: Date | null = null;
  for (const e of sorted) {
    const p = rec(e.payload);
    const budgetSpent = num(rec(p['budget'])['spent_usd']);
    const delta = budgetSpent === null ? 0 : Math.max(0, round6(budgetSpent - spent));
    const elapsed = previousAt === null ? 0 : Math.max(0, e.at.getTime() - previousAt.getTime());
    switch (e.kind) {
      case EV.accessReport: {
        const view = rec(p['view']);
        const signal = str(view['signal']);
        out.push({
          kind: 'access_report',
          step: (step += 1),
          signal: signal === 'allowed' || signal === 'review' ? signal : null,
          cost_usd: 0,
          ms: elapsed,
        });
        break;
      }
      case EV.reconnaissance: {
        out.push({
          kind: 'reconnaissance',
          step: (step += 1),
          mode: codeOrNull(p['mode']),
          sources: Array.isArray(p['candidates']) ? p['candidates'].length : 0,
          failure_class: codeOrNull(p['failure_class']),
          cost_usd: delta,
          ms: elapsed,
        });
        break;
      }
      case EV.schemaProposed: {
        const schema = rec(p['output_schema']);
        out.push({ kind: 'schema', step: null, ok: p['ok'] === true, fields: p['ok'] === true ? Object.keys(rec(schema['properties'])).length : null });
        break;
      }
      case EV.attemptFinished: {
        const a = rec(p['attempt']);
        const runs = Array.isArray(p['executions']) ? p['executions'].map(rec) : [];
        const last = runs.at(-1);
        out.push({
          kind: 'attempt',
          step: (step += 1),
          execution: codeOf(a['execution']),
          network: codeOf(a['network']),
          result: codeOf(a['result']),
          records: num(last?.['records']),
          pages: num(last?.['pages']),
          est_cost_usd: num(a['est_cost_usd']),
          cost_usd: num(a['cost_usd']) ?? delta,
          ms: num(a['ms']),
        });
        break;
      }
      case EV.attemptPruned: {
        const by = rec(p['by']);
        out.push({
          kind: 'pruned',
          step: null,
          by: str(by['execution']) === null ? null : { execution: codeOf(by['execution']), network: codeOf(by['network']) },
          reason: codeOrNull(p['reason']),
          count: Array.isArray(p['pruned']) ? p['pruned'].length : 0,
        });
        break;
      }
      case EV.actionRequired:
        out.push({ kind: 'action_required', step: null, cause: codeOf(p['cause']) });
        break;
      case EV.finished: {
        const s = rec(p['strategy']);
        out.push({
          kind: 'finished',
          step: null,
          outcome: codeOf(p['outcome']),
          strategy: str(s['execution']) === null ? null : { version: num(s['version']), execution: codeOf(s['execution']), network: codeOf(s['network']), est_cost_usd: num(s['est_cost_usd']) },
          items: num(p['items']),
          stop_reason: codeOrNull(p['stop_reason']),
          failure_class: codeOrNull(p['failure_class']),
        });
        break;
      }
      default:
        break;
    }
    if (budgetSpent !== null) spent = budgetSpent;
    previousAt = e.at;
  }
  return out;
}

/** Événements d'une enquête de l'acteur (lecture sous RLS : un run d'autrui ne rend rien). */
async function readInvestigationEvents(db: Queryable, runId: string): Promise<EventRow[]> {
  const { rows } = await db.query<EventRow>('SELECT seq, kind, payload, at FROM investigation_events WHERE run_id = $1 ORDER BY seq', [runId]);
  return rows;
}

/** Chronologie d'une enquête de l'acteur. */
export async function investigationTimeline(ctx: ServerContext, actor: Actor, runId: string, slug: string): Promise<TimelineEntry[]> {
  const events = await withActor(ctx.pool, actor, (db) => readInvestigationEvents(db, runId));
  return buildTimeline(events, slug);
}

/** Dernier événement d'une enquête (numéro d'ordre et chronologie) : source de la progression MCP. */
export async function investigationProgressOf(ctx: ServerContext, actor: Actor, runId: string, slug: string): Promise<{ seq: number; timeline: TimelineEntry[] } | null> {
  const events = await withActor(ctx.pool, actor, (db) => readInvestigationEvents(db, runId));
  const last = events.at(-1);
  return last === undefined ? null : { seq: last.seq, timeline: buildTimeline(events, slug) };
}
