// SPDX-License-Identifier: AGPL-3.0-only
// Bloc de résultat d'une enquête (lot A du CDC UX, 03-specs-mcp § 2, § 3 et § 10.2) : le MÊME bloc pour `create_api`,
// `get_run` et `validate_schema`, lu depuis la base (le run d'enquête, l'API, le premier run complet, le dataset, la porte
// du schéma). Il dit où en est la demande (`state`, `phase`, `progress`), rend les données quand elles existent
// (`items_total`, `items_preview`, `items_cursor`), pose la question unique quand une décision est due (`question`) et
// désigne la suite (`next_action`). Aucune valeur d'une API d'autrui : toutes les lectures passent par `withActor`, la porte
// (`apis.investigation.gate`) par une lecture propriétaire seulement.
import { INVESTIGATION_MILESTONES, milestoneLabel, type GateReason, type InvestigationGate, type InvestigationMilestone } from '@runtime/core/investigation';
import { withActor } from '@runtime/db';
import type { ServerContext } from '../context.js';
import { readApiById, type ApiRow } from '../rest/apis.js';
import { itemsCursor, readRunRow, type RunRow } from '../rest/runs.js';
import { iso, usd, usdOrNull } from '../rest/shared.js';
import type { Actor } from '../routes/guard.js';
import { journeyTexts } from './journey-texts.js';
import type { McpLocale } from './texts.js';

type Json = Record<string, unknown>;

/** Intervalle sans événement au bout duquel un battement de progression part (03 § 5 : un jalon libellé toutes les 5 s au plus). */
export const PROGRESS_HEARTBEAT_MS = 4_000;

/** Aperçu rendu dans la réponse (03 § 2) : 10 éléments, 6 colonnes dans le tableau du texte. */
export const PREVIEW_ITEMS = 10;
const PREVIEW_COLUMNS = 6;
const CELL_MAX = 40;

export type BlockState = 'running' | 'awaiting_decision' | 'succeeded' | 'failed' | 'action_required' | 'blocked';
export type BlockPhase = 'describe' | 'recognize' | 'validate_schema' | 'extract';

/** Jalon courant (1 à 4) d'une phase de l'enquête : le même découpage que la frise de la console (`MILESTONE_OF_PHASE`). */
export function stepOf(phase: string | null): { step: 1 | 2 | 3 | 4; phase: BlockPhase } {
  switch (phase) {
    case null:
      return { step: 1, phase: 'describe' };
    case 'access_check':
    case 'reconnaissance':
      return { step: 2, phase: 'recognize' };
    case 'awaiting_schema_validation':
      return { step: 3, phase: 'validate_schema' };
    default:
      return { step: 4, phase: 'extract' };
  }
}

/** Libellé d'un jalon, dans la langue de la personne (catalogue commun du noyau, le même que la console). */
export const milestoneText = (step: number, locale: McpLocale): string => milestoneLabel(INVESTIGATION_MILESTONES[Math.max(0, Math.min(3, step - 1))] as InvestigationMilestone, locale);

/** « 2/4 Reconnaître » : le libellé d'un jalon avec son rang. */
export const progressLabel = (step: number, locale: McpLocale): string => `${step}/4 ${milestoneText(step, locale)}`;

const ACTIVE = new Set<string>(['queued', 'running', 'waiting_tunnel']);

/** Raison de la question (ordre de priorité : une seule est posée, les autres se règlent avec « continuer »). */
const PRIORITY = ['multiple_lists', 'requested_field_missing', 'example_mismatch', 'cost_above_cap'] as const;

export type QuestionOption = { id: string; label: string; expected_items?: number; estimate_usd?: number };
export type Question = { reason: (typeof PRIORITY)[number]; text: string; options: QuestionOption[] };

/** Question unique et fermée d'une porte (03 § 4 et § 9) ; null sans porte. Options numérotées dans `text`, identifiants stables. */
export function questionOf(gate: InvestigationGate | null, locale: McpLocale): Question | null {
  if (gate === null || gate.reasons.length === 0) return null;
  const q = journeyTexts(locale).question;
  const reason = PRIORITY.map((r) => gate.reasons.find((g) => g.reason === r)).find((g): g is GateReason => g !== undefined);
  if (reason === undefined) return null;
  const build = (head: string, options: QuestionOption[]): Question => ({ reason: reason.reason, text: q.render(head, options.map((o) => o.label)), options });
  switch (reason.reason) {
    case 'multiple_lists': {
      const t = q.multipleLists(reason.chosen.items, reason.other.items);
      return build(t.text, [
        { id: 'continue', label: t.chosen, expected_items: reason.chosen.items },
        { id: 'other_list', label: t.other, expected_items: reason.other.items },
      ]);
    }
    case 'requested_field_missing': {
      const t = q.requestedMissing(reason.fields);
      return build(t.text, [
        { id: 'continue', label: `${t.carryOn}` },
        { id: 'look_details', label: t.details },
      ]);
    }
    case 'example_mismatch': {
      const t = q.exampleMismatch(reason.fields);
      return build(t.text, [
        { id: 'continue', label: t.carryOn },
        { id: 'other', label: t.other },
      ]);
    }
    case 'cost_above_cap': {
      const t = q.cost(reason.estimate_usd, reason.compile_usd);
      return build(t.text, [
        { id: 'continue', label: t.carryOn, estimate_usd: reason.estimate_usd },
        { id: 'cancel', label: t.cancel },
      ]);
    }
  }
}

/**
 * Porte de l'enquête de l'API, nom choisi, description, URL de départ et colonnes proposées (ordre DÉCLARÉ des champs : jsonb ne
 * garde pas l'ordre des clés d'un objet), lus par son propriétaire seulement (la colonne reste lisible des membres en visibilité instance).
 */
export async function readGate(ctx: ServerContext, actor: Actor, apiId: string): Promise<{ gate: InvestigationGate | null; name: string | null; description: string; url: string | null; columns: string[] | null }> {
  const row = await withActor(ctx.pool, actor, async (db) =>
    (
      await db.query<{ gate: InvestigationGate | null; name: string | null; description: string; url: string | null; columns: string[] | null }>(
        `SELECT investigation -> 'gate' AS gate, investigation #>> '{request,name}' AS name, description, investigation #>> '{request,url}' AS url,
                investigation -> 'proposed_columns' AS columns
         FROM apis WHERE id = $1 AND owner_id = $2`,
        [apiId, actor.userId],
      )
    ).rows[0],
  );
  return row === undefined ? { gate: null, name: null, description: '', url: null, columns: null } : row;
}

/** Nom lisible : celui de la personne, sinon tiré du slug (« biens-janssens-immobilier-ab12cd » → « Biens Janssens Immobilier »). */
export function displayName(slug: string, chosen: string | null): string {
  if (chosen !== null && chosen !== '') return chosen;
  const base = slug.replace(/-[0-9a-f]{6}$/, '');
  return base.split('-').filter((w) => w !== '').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/** Premier run ordinaire d'une API lancé APRÈS l'enquête (le « premier run complet » de 03 § 2) ; null s'il n'existe pas encore. */
export async function readFirstRun(ctx: ServerContext, actor: Actor, apiId: string, after: Date): Promise<RunRow | null> {
  return withActor(ctx.pool, actor, async (db) => {
    const found = await db.query<{ id: string }>("SELECT id FROM runs WHERE api_id = $1 AND kind = 'run' AND created_at >= $2 ORDER BY created_at LIMIT 1", [apiId, after]);
    const id = found.rows[0]?.id;
    return id === undefined ? null : readRunRow(db, id);
  });
}

/** Le premier run complet doit-il suivre l'enquête ? Enquête réussie, API prête, entrée sans champ requis. */
export function firstRunDue(inv: Pick<RunRow, 'kind' | 'state'>, api: Pick<ApiRow, 'status' | 'investigation_phase' | 'input_schema' | 'current_strategy_version'>): boolean {
  if (inv.kind !== 'investigation' || inv.state !== 'succeeded') return false;
  if ((api.status !== 'sain' && api.status !== 'warning') || api.investigation_phase !== 'done' || api.current_strategy_version === null) return false;
  const required = (api.input_schema as { required?: unknown } | null)?.required;
  return !(Array.isArray(required) && required.length > 0);
}

/** Échappe une cellule de tableau Markdown : une ligne, `|` neutralisé, tronquée proprement. */
function cell(value: unknown): string {
  const raw = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const flat = raw.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  return flat.length > CELL_MAX ? `${flat.slice(0, CELL_MAX - 1)}…` : flat;
}

/** Tableau Markdown de l'aperçu : 6 colonnes au plus, dans l'ordre du schéma ; vide sans élément. */
export function previewTable(rows: readonly Json[], columns: readonly string[]): string {
  if (rows.length === 0) return '';
  const present = new Set(rows.flatMap((r) => Object.keys(r)));
  const ordered = [...columns.filter((c) => present.has(c)), ...[...present].filter((c) => !columns.includes(c)).sort()].slice(0, PREVIEW_COLUMNS);
  if (ordered.length === 0) return '';
  const head = `| ${ordered.map(cell).join(' | ')} |`;
  const rule = `| ${ordered.map(() => '---').join(' | ')} |`;
  return [head, rule, ...rows.map((r) => `| ${ordered.map((c) => cell(r[c])).join(' | ')} |`)].join('\n');
}

type ItemsRead = { total: number; preview: Json[]; cursor: string | null; columns: string[] };

async function readItems(ctx: ServerContext, actor: Actor, datasetId: string, apiId: string): Promise<ItemsRead> {
  return withActor(ctx.pool, actor, async (db) => {
    const count = await db.query<{ item_count: number }>('SELECT item_count FROM datasets WHERE id = $1 AND deleted_at IS NULL', [datasetId]);
    const page = await db.query<{ seq: number; item: Json }>('SELECT seq, item FROM dataset_items WHERE dataset_id = $1 ORDER BY seq LIMIT $2', [datasetId, PREVIEW_ITEMS]);
    const cols = await db.query<{ output_columns: string[] | null }>('SELECT output_columns FROM apis WHERE id = $1', [apiId]);
    const total = count.rows[0]?.item_count ?? page.rows.length;
    const last = page.rows.at(-1)?.seq;
    return { total, preview: page.rows.map((r) => r.item), cursor: total > page.rows.length && last !== undefined ? itemsCursor(last) : null, columns: cols.rows[0]?.output_columns ?? [] };
  });
}

export type BlockInput = {
  ctx: ServerContext;
  actor: Actor;
  locale: McpLocale;
  /** Run d'enquête : celui que `create_api` a rendu ; il reste l'identifiant du parcours jusqu'au résultat. */
  runId: string;
  existing?: boolean;
  /** Corps de la porte déjà lu (évite une seconde lecture), sinon lu ici. */
  gate?: InvestigationGate | null;
};

export type ResultBlock = {
  /** Champs ajoutés à `structuredContent` (spec 10.2). */
  fields: Json;
  state: BlockState;
  question: Question | null;
  items: ItemsRead | null;
  /** Dataset des éléments rendus (premier run complet, sinon sortie de l'enquête) ; null sans éléments. */
  datasetId: string | null;
  replayUsd: number | null;
  /** Marque d'un premier run encore en cours : le parcours n'est pas fini. */
  firstRunActive: boolean;
  /** Champs du schéma proposé, dans l'ordre déclaré (lus de l'état de l'enquête) ; null sans état. */
  proposedColumns: string[] | null;
};

/**
 * Bloc de résultat d'un run d'enquête, ou null si le run n'est pas une enquête (un run ordinaire garde son enveloppe).
 * `firstRun` : le premier run complet déjà lancé pour cette enquête (lu ici s'il n'est pas donné).
 */
export async function buildResultBlock(input: BlockInput & { firstRun?: RunRow | null }): Promise<ResultBlock | null> {
  const { ctx, actor, locale } = input;
  const inv = await withActor(ctx.pool, actor, (db) => readRunRow(db, input.runId));
  if (inv === null || inv.kind !== 'investigation') return null;
  const api = await withActor(ctx.pool, actor, (db) => readApiById(db, inv.api_id));
  if (api === null) return null;
  const isOwner = api.owner_id === actor.userId;
  const first = input.firstRun !== undefined ? input.firstRun : inv.finished_at === null ? null : await readFirstRun(ctx, actor, api.id, inv.finished_at);
  const read = isOwner ? await readGate(ctx, actor, api.id) : { gate: null, name: null, description: '', url: null, columns: null };
  const gate = input.gate !== undefined ? input.gate : read.gate;
  const named = read.name;
  const awaiting = api.investigation_phase === 'awaiting_schema_validation' && inv.state === 'succeeded';

  let state: BlockState;
  if (ACTIVE.has(inv.state)) state = 'running';
  else if (awaiting) state = 'awaiting_decision';
  else if (inv.state === 'succeeded') {
    if (first !== null) state = ACTIVE.has(first.state) ? 'running' : first.state === 'succeeded' ? 'succeeded' : 'failed';
    else state = api.status === 'bloquee' ? 'blocked' : api.status === 'action_requise' ? 'action_required' : api.status === 'erreur' ? 'failed' : 'succeeded';
  } else state = api.status === 'bloquee' ? 'blocked' : api.status === 'action_requise' ? 'action_required' : 'failed';

  // Données : le premier run complet quand il a réussi, sinon ce que l'enquête a livrée (sortie de son dernier essai conforme).
  const resultRun = first !== null && first.state === 'succeeded' && first.dataset_id !== null ? first : inv.state === 'succeeded' && inv.dataset_id !== null ? inv : null;
  const items = resultRun === null || resultRun.dataset_id === null || awaiting ? null : await readItems(ctx, actor, resultRun.dataset_id, api.id);
  const strategy = api.current_strategy_version === null ? null : await withActor(ctx.pool, actor, async (db) => (await db.query<{ est_cost_usd: string | null }>('SELECT est_cost_usd FROM strategy_versions WHERE api_id = $1 AND version = $2', [api.id, api.current_strategy_version])).rows[0]);
  const replayUsd = strategy === null || strategy === undefined ? null : usdOrNull(strategy.est_cost_usd);
  const { step, phase } = stepOf(state === 'running' && inv.state === 'succeeded' ? 'testing' : api.investigation_phase);
  const question = awaiting ? questionOf(gate, locale) : null;
  const invCost = usd(inv.cost_proxy_usd) + (usdOrNull(inv.cost_llm_usd) ?? 0);
  const firstCost = first === null ? 0 : usd(first.cost_proxy_usd) + (usdOrNull(first.cost_llm_usd) ?? 0);
  const active = state === 'running';
  const fields: Json = {
    api_id: api.id,
    slug: api.slug,
    name: displayName(api.slug, named),
    run_id: inv.id,
    existing: input.existing === true,
    state,
    phase,
    progress: { step, of: 4, label: progressLabel(step, locale) },
    poll_after_seconds: active && inv.paused_at === null ? 5 : null,
    eta_seconds: null,
    items_total: items?.total ?? (state === 'succeeded' ? 0 : null),
    items_preview: items?.preview ?? [],
    items_cursor: items?.cursor ?? null,
    cost: { investigation_usd: Math.round((invCost + firstCost) * 1e6) / 1e6, replay_estimate_usd: replayUsd },
    // L'onglet Données de la fiche arrive avec U2.5 (lot G) : d'ici là, la fiche de l'API.
    console_url: `${ctx.publicUrl}/apis/${api.slug}`,
    ...(question === null ? {} : { question }),
    ...(first === null ? {} : { first_run_id: first.id }),
    ...(inv.finished_at === null ? {} : { finished_at: iso(inv.finished_at) }),
  };
  return { fields, state, question, items, datasetId: items === null || resultRun === null ? null : resultRun.dataset_id, replayUsd, firstRunActive: first !== null && ACTIVE.has(first.state), proposedColumns: read.columns };
}

/** Texte du début de la réponse : le succès chiffré et l'aperçu, ou la question unique ; vide sinon. */
export function blockHead(block: ResultBlock, locale: McpLocale, extra: { nextItemsIds?: string | null } = {}): string {
  const t = journeyTexts(locale);
  if (block.state === 'awaiting_decision' && block.question !== null) return `${block.question.text}\n${t.question.reply('validate_schema')}`;
  if (block.state !== 'succeeded' || block.items === null) return '';
  const total = block.items.total;
  // Un rejeu sous 0,0001 $ se dit « 0 $ » (la fin de récit de 08 § 2).
  const head = t.done(total, (block.replayUsd ?? 0) < 0.0001 ? 0 : block.replayUsd!);
  if (block.items.preview.length === 0) return `${head}\n${t.empty}`;
  const table = previewTable(block.items.preview, block.items.columns);
  const more = block.items.cursor !== null && extra.nextItemsIds ? `\n${t.moreItems(extra.nextItemsIds)}` : '';
  return `${head}\n${t.preview(block.items.preview.length, total)}\n${table}${more}`;
}
