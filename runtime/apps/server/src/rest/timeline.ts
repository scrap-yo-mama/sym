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
/**
 * Source candidate de la reconnaissance (D-124, cdc/scrapyomama-ux/03-specs-mcp.md §9 bis) : identifiant stable, type, nombre
 * d'éléments, compteur affiché par le site, rôle lu par le code, pagination détectée ; `retained` et sa raison une fois
 * l'enquête finie. Codes et nombres seulement (aucun texte du site dans la chronologie) : l'aperçu de 3 éléments est dans
 * l'événement `reconnaissance.finished` du flux (`GET /api/runs/{id}/events`), `preview_items` en donne le nombre.
 */
type TimelineSource = {
  source_id: string;
  type: 'dom' | 'json' | 'xhr' | 'blob';
  count: number | null;
  counter: number | null;
  role: 'results' | 'carousel' | null;
  pagination: { type: string; param: string | null; step: number | null } | null;
  preview_items: number;
  retained: boolean;
  reason: string | null;
};
export type TimelineRecon = { kind: 'reconnaissance'; step: number; mode: string | null; sources: number; candidates: TimelineSource[]; failure_class: string | null; cost_usd: number; ms: number };
/**
 * Validation du schéma PAR L'UTILISATEUR (`validate_schema`, constat Barnes) : ce qui a changé par rapport à la proposition,
 * ce qui n'est pas appliqué, consignes reçues (oui ou non, jamais leur texte), source choisie et retrouvée au run. Noms de
 * champs du schéma du client, filtrés sur la forme d'un nom (20 par liste au plus) : jamais un texte du site.
 */
export type TimelineSchemaValidated = {
  kind: 'schema_validated';
  step: null;
  corrected: boolean;
  changes: {
    added: string[];
    removed: string[];
    renamed: { from: string; to: string }[];
    type_changed: string[];
    description_changed: string[];
    required_changed: string[];
    other_changed: string[];
  };
  not_applied: { code: string; field: string }[];
  instructions: boolean;
  source_id: string | null;
  source_found: boolean | null;
};
/** Écarts du schéma proposé avec le schéma précédent de l'API (UX-25) : noms de champs seulement. */
type SchemaChanges = { dropped: string[]; added: string[]; retyped: string[]; renamed: { from: string; to: string }[] };
type TimelineSchema = { kind: 'schema'; step: null; ok: boolean; fields: number | null; changes?: SchemaChanges };
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
  /**
   * Motif d'un échec (`why` de l'événement) : code et, pour un refus de la garde des requêtes, son motif (codes seulement, UX-33).
   * `params` (U1.12) : champ du schéma et raison du contenu minimal (UX-21), classe d'erreur du moteur agentique (UX-23).
   */
  why?: { code: string; reason: string | null; params?: CauseParams } | null;
};
/** Paramètres publiés d'une cause : trois clés fermées, valeurs de la forme d'un code ou d'un nom de champ du schéma. */
type CauseParams = { field?: string; reason?: string; class?: string };
/** Compilation du HTML refusée (UX-37) : écart d'ensemble et différentiel par champ (écarts, deux exemples déjà masqués). */
export type TimelineCompile = {
  kind: 'compile';
  step: null;
  ok: boolean;
  reason: string | null;
  expected: number | null;
  got: number | null;
  ratio: number | null;
  fields: { field: string; compared: number; mismatched: number; examples: { expected: string | null; got: string | null }[]; masked?: true }[];
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
  /** Cause exacte de la fin (`detail` du worker, code) et ses paramètres : `llm_settings_unreadable` + raison (UX-15). */
  detail?: string | null;
  detail_params?: CauseParams;
  /** Pages demandées par la description et ce qui en a été fait (UX-26) : `max_pages_default` ou `not_paginated`. */
  pages_requested?: { pages: number; outcome: 'max_pages_default' | 'not_paginated' };
};
export type TimelineEntry = TimelineStart | TimelineAccess | TimelineRecon | TimelineSchema | TimelineSchemaValidated | TimelineAttempt | TimelinePruned | TimelineAction | TimelineFinished | TimelineCompile;

/** Nom de champ du schéma de sortie (identifiant), borné : jamais un texte libre. */
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
/** Paramètres d'une cause : `field`, `reason` et `class` seulement, chacun filtré (codes ; noms de champs). */
function causeParams(raw: unknown): CauseParams | undefined {
  const p = rec(raw);
  const field = typeof p['field'] === 'string' && FIELD_NAME.test(p['field']) ? p['field'] : null;
  const reason = codeOrNull(p['reason']);
  const klass = codeOrNull(p['class']);
  if (field === null && reason === null && klass === null) return undefined;
  return { ...(field === null ? {} : { field }), ...(reason === null ? {} : { reason }), ...(klass === null ? {} : { class: klass }) };
}

const names = (v: unknown, max = 50): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string' && FIELD_NAME.test(n)).slice(0, max) : []);
/** Écarts de schéma publiés : listes de noms de champs filtrés ; absents si rien n'a changé. */
function schemaChanges(raw: unknown): SchemaChanges | undefined {
  const c = rec(raw);
  const renamed = (Array.isArray(c['renamed']) ? c['renamed'].map(rec) : [])
    .filter((r) => typeof r['from'] === 'string' && FIELD_NAME.test(r['from']) && typeof r['to'] === 'string' && FIELD_NAME.test(r['to']))
    .slice(0, 50)
    .map((r) => ({ from: r['from'] as string, to: r['to'] as string }));
  const out: SchemaChanges = { dropped: names(c['dropped']), added: names(c['added']), retyped: names(c['retyped']), renamed };
  return out.dropped.length + out.added.length + out.retyped.length + out.renamed.length === 0 ? undefined : out;
}

/** Exemple publié d'un différentiel : texte borné ou absence (le worker a déjà masqué les valeurs personnelles). */
const sample = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, 81) : null);

const SOURCE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Entrée de la validation de l'utilisateur, d'après la charge de `schema.validated` (codes et noms filtrés). */
export function schemaValidatedEntry(p: Rec): TimelineSchemaValidated {
  const c = rec(p['changes']);
  const renamed = (Array.isArray(c['renamed']) ? c['renamed'] : [])
    .map(rec)
    .filter((r) => typeof r['from'] === 'string' && FIELD_NAME.test(r['from']) && typeof r['to'] === 'string' && FIELD_NAME.test(r['to']))
    .slice(0, 20)
    .map((r) => ({ from: r['from'] as string, to: r['to'] as string }));
  const notApplied = (Array.isArray(p['not_applied']) ? p['not_applied'] : [])
    .map(rec)
    .filter((n) => typeof n['field'] === 'string' && FIELD_NAME.test(n['field']))
    .slice(0, 20)
    .map((n) => ({ code: codeOf(n['code']), field: n['field'] as string }));
  const source = typeof p['source_id'] === 'string' && SOURCE.test(p['source_id']) ? p['source_id'] : null;
  return {
    kind: 'schema_validated',
    step: null,
    corrected: p['corrected'] === true,
    changes: {
      added: names(c['added'], 20),
      removed: names(c['removed'], 20),
      renamed,
      type_changed: names(c['type_changed'], 20),
      description_changed: names(c['description_changed'], 20),
      required_changed: names(c['required_changed'], 20),
      other_changed: names(c['other_changed'], 20),
    },
    not_applied: notApplied,
    instructions: p['instructions'] === true,
    source_id: source,
    source_found: source === null || typeof p['source_found'] !== 'boolean' ? null : p['source_found'],
  };
}

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
          candidates: Array.isArray(p['candidates']) ? p['candidates'].slice(0, 8).map(sourceOf) : [],
          failure_class: codeOrNull(p['failure_class']),
          cost_usd: delta,
          ms: elapsed,
        });
        break;
      }
      case EV.schemaProposed: {
        const schema = rec(p['output_schema']);
        const changes = schemaChanges(p['changes']);
        out.push({ kind: 'schema', step: null, ok: p['ok'] === true, fields: p['ok'] === true ? Object.keys(rec(schema['properties'])).length : null, ...(changes === undefined ? {} : { changes }) });
        break;
      }
      case EV.schemaValidated: {
        // Validation automatique (`auto_validate`) : aucune entrée (rien n'a été corrigé ni choisi par l'utilisateur).
        if (p['by'] === 'user') out.push(schemaValidatedEntry(p));
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
          ...(str(rec(p['why'])['code']) === null
            ? {}
            : (() => {
                const params = causeParams(rec(p['why'])['params']);
                return { why: { code: codeOf(rec(p['why'])['code']), reason: codeOrNull(rec(rec(p['why'])['params'])['reason']), ...(params === undefined ? {} : { params }) } };
              })()),
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
      case EV.strategyCompiled: {
        // Seule une compilation REFUSÉE entre dans la chronologie (la réussite est dite par la fin d'enquête).
        if (p['ok'] === true) break;
        const fields = Array.isArray(p['fields']) ? p['fields'].map(rec).filter((f) => typeof f['field'] === 'string' && FIELD_NAME.test(f['field'])).slice(0, 12) : [];
        out.push({
          kind: 'compile',
          step: null,
          ok: false,
          reason: codeOrNull(p['reason']),
          expected: num(p['expected']),
          got: num(p['got']),
          ratio: num(p['ratio']),
          fields: fields.map((f) => ({
            field: f['field'] as string,
            compared: num(f['compared']) ?? 0,
            mismatched: num(f['mismatched']) ?? 0,
            examples: (Array.isArray(f['examples']) ? f['examples'] : []).slice(0, 2).map((e) => ({ expected: sample(rec(e)['expected']), got: sample(rec(e)['got']) })),
            ...(f['masked'] === true ? { masked: true as const } : {}),
          })),
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
          ...(typeof p['detail'] === 'string' && CODE.test(p['detail']) ? { detail: p['detail'] } : {}),
          ...(() => {
            const asked = rec(p['pages_requested']);
            const pages = num(asked['pages']);
            const outcome = asked['outcome'];
            return pages !== null && (outcome === 'max_pages_default' || outcome === 'not_paginated') ? { pages_requested: { pages, outcome } } : {};
          })(),
          ...(causeParams(p['detail_params']) === undefined ? {} : { detail_params: causeParams(p['detail_params'])! }),
        });
        break;
      }
      default:
        break;
    }
    if (budgetSpent !== null) spent = budgetSpent;
    previousAt = e.at;
  }
  // Source retenue (D-124) : celle de la stratégie de l'enquête finie ; un carrousel écarté le dit.
  const retained = str(rec(rec(sorted.findLast((e) => e.kind === EV.finished)?.payload)['strategy'])['source']);
  for (const entry of out) {
    if (entry.kind !== 'reconnaissance') continue;
    for (const source of entry.candidates) {
      source.retained = retained !== null && source.source_id === retained;
      source.reason = source.retained ? (source.role === 'results' ? 'results_list_conformant' : 'first_conformant_trial') : source.role === 'carousel' ? 'carousel_penalized' : null;
    }
  }
  return out;
}

/** Emplacement d'un paramètre de pagination (`url.query.begin`, `url.path`) : forme stricte, sinon `null`. */
const PARAM_AT = /^url\.(?:path|query\.[A-Za-z0-9_-]{1,40})$/;
const paramOf = (v: unknown): string | null => (typeof v === 'string' && PARAM_AT.test(v) ? v : null);

/** Source candidate d'un événement de reconnaissance, relue défensivement (codes et nombres seulement). */
function sourceOf(raw: unknown): TimelineSource {
  const c = rec(raw);
  const type = str(c['type']);
  const role = str(c['role']);
  const pagination = c['pagination'] === null || c['pagination'] === undefined ? null : rec(c['pagination']);
  return {
    source_id: codeOf(c['source_id'] ?? c['id']),
    type: type === 'dom' || type === 'json' || type === 'xhr' || type === 'blob' ? type : str(c['from']) === 'dom' ? 'dom' : str(c['from']) === 'embedded' ? 'blob' : 'json',
    count: num(c['count']),
    counter: num(c['counter']),
    role: role === 'results' || role === 'carousel' ? role : null,
    pagination: pagination === null ? null : { type: codeOf(pagination['type']), param: paramOf(pagination['param']), step: num(pagination['step']) },
    preview_items: Array.isArray(c['preview']) ? Math.min(3, c['preview'].length) : 0,
    retained: false,
    reason: null,
  };
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

/** Progression lisible d'une enquête en cours (indice `progress` de RunResult) : codes et nombres seulement, aucun texte du site. */
export type InvestigationProgress = {
  readonly phase: string;
  readonly strategies_tried: number;
  readonly last_attempt: { readonly execution: string; readonly network: string; readonly result: string } | null;
  readonly message: string;
};

/**
 * Indice `progress` pendant une enquête (constat Janssens : le client, sans nouvelles, a extrait le site lui-même) : la phase
 * courante, les stratégies déjà essayées et une phrase pour le modèle client (anglais, 21 § 4.3) qui rappelle que SYM fait
 * l'extraction et qu'il suffit de relire `get_run`.
 */
export function investigationProgress(timeline: readonly TimelineEntry[]): InvestigationProgress {
  const start = timeline.find((e): e is TimelineStart => e.kind === 'investigation');
  const attempts = timeline.filter((e): e is TimelineAttempt => e.kind === 'attempt');
  const last = attempts.at(-1);
  const phase = start?.phase ?? 'investigating';
  const doing =
    phase === 'testing'
      ? `SYM is testing extraction strategies, cheapest first: ${attempts.length} tried${last === undefined ? '' : ` (last: ${last.execution} on ${last.network}, ${last.result})`}.`
      : phase === 'reconnaissance'
        ? 'SYM is looking for the data on the page: JSON responses, embedded data, repeated HTML blocks and pagination.'
        : phase === 'awaiting_schema_validation' || phase === 'schema'
          ? 'SYM is proposing the output schema.'
          : 'SYM is checking access to the site.';
  return {
    phase,
    strategies_tried: attempts.length,
    last_attempt: last === undefined ? null : { execution: last.execution, network: last.network, result: last.result },
    message: `${doing} SYM extracts every page itself: keep polling get_run, do not fetch the site yourself.`,
  };
}
