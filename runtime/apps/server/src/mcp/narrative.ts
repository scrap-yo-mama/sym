// SPDX-License-Identifier: AGPL-3.0-only
// Récit de l'enquête (tâche 3.10, 05 § 1.2) : le texte de `content`, rendu depuis les MÊMES entrées de `timeline[]` que
// celles de `structuredContent` (rest/timeline.ts, dérivées de `investigation_events`). Obligatoire : `content` est le
// seul canal garanti dans tous les clients (`assert_text_only_sufficient`) ; le texte et la structure citent les mêmes
// essais et les mêmes coûts (`assert_narrative_matches_structured`).
//
// Gabarits fermés (texts.ts) : jamais un texte du site ni du dossier d'enquête. Le dossier (19c § 7) n'entre que par des
// identifiants validés (`h1`), des types et des états du code ; huit lignes d'indices au plus.
import { codeOf, codeOrNull, hostOrNull, type TimelineAccess, type TimelineAttempt, type TimelineEntry, type TimelineFinished, type TimelineRecon } from '../rest/timeline.js';
import {
  ACTION_CAUSES,
  actionTemplate,
  BLOCKED_CAUSES,
  blockedTemplate,
  EXECUTION_CODE,
  fmtSeconds,
  fmtUsd,
  narrativeCatalog,
  type McpLocale,
} from './texts.js';
import { apiToolName } from './tools.js';

/** Un indice du dossier d'enquête (19c § 7, R7 § 5) : identifiant validé, type, état et code de raison du CODE, jamais un texte. */
type BriefReportEntry = { id: string; kind: string; state: string; reason_code?: string | null; cost_usd?: number | null; probe_ms?: number | null };

/** Faits du dossier pour le récit : comptes, états par indice, coupe-circuit, questions ouvertes. */
export type BriefNarrative = { hints: number; tried: number; report: readonly BriefReportEntry[]; breaker?: boolean; open_questions?: number };

export type NarrativeInput = {
  timeline: readonly TimelineEntry[];
  /** Coût total de l'enquête (enveloppe `cost.total_usd`). */
  totalUsd: number | null;
  /** État du run : un run encore actif ajoute « l'enquête est en cours ». */
  state: string;
  consoleUrl: string;
  nextAction: { tool: string; args?: unknown } | null;
  pollAfterSeconds: number | null;
  brief?: BriefNarrative;
  /** Remarque de la personne après une élicitation « modifier » : le récit propose d'ajuster le schéma. */
  schemaRemark?: boolean;
};

const BRIEF_KINDS = ['endpoint', 'embedded_data', 'selector', 'pagination', 'example_url', 'pitfall'];
const BRIEF_ID = /^[a-z0-9_-]{1,16}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,39}$/;
/** Lignes d'indices au plus (19c § 7), puis « … et N autres, dans la console ». */
export const BRIEF_MAX_LINES = 8;

const ACTIVE = new Set(['queued', 'running', 'waiting_tunnel']);

/**
 * Le générateur filtre lui-même chaque code qu'il écrit (cause, stop_reason, failure_class, result, raison d'élagage, mode,
 * phase, chemin) : forme d'un code, sinon `unknown` ; domaine : forme d'un nom d'hôte, sinon rien. La chronologie applique
 * déjà ces filtres (rest/timeline.ts) ; le récit ne compte pas sur elle : une entrée venue d'ailleurs n'y glisse aucun texte.
 */
const pathLabel = (e: { execution: string; network: string }) => `${codeOf(e.execution)}/${codeOf(e.network)}`;

/** Texte d'une étape ou d'un jalon, sans numéro (le récit le numérote ; la progression MCP l'utilise telle quelle). */
export function entryText(entry: TimelineEntry, locale: McpLocale): string | null {
  const c = narrativeCatalog(locale);
  const cost = (e: { cost_usd: number; ms: number | null }) => `[${fmtSeconds(e.ms, locale)}, ${fmtUsd(e.cost_usd, locale)}]`;
  const space = locale === 'fr' ? ' : ' : ': ';
  switch (entry.kind) {
    case 'access_report': {
      const e: TimelineAccess = entry;
      return `${locale === 'fr' ? 'Rapport d’accès' : 'Access report'}${space}${e.signal === null ? c.access.unknown : c.access[e.signal]} ${cost(e)}`;
    }
    case 'reconnaissance': {
      const e: TimelineRecon = entry;
      return `Reconnaissance${space}${e.failure_class === null ? c.recon(e.sources, codeOrNull(e.mode)) : c.reconFailed(codeOf(e.failure_class))} ${cost(e)}`;
    }
    case 'attempt': {
      const e: TimelineAttempt = entry;
      return `${c.trial(pathLabel(e), e.result === 'ok', codeOf(e.result), e.records, e.pages)} ${cost(e)}`;
    }
    case 'schema':
      return c.schema(entry.ok, entry.fields);
    case 'pruned':
      return entry.count === 0 ? null : c.pruned(entry.by === null ? null : pathLabel(entry.by), codeOrNull(entry.reason), entry.count);
    case 'action_required':
      return (BLOCKED_CAUSES as readonly string[]).includes(entry.cause) ? blockedTemplate(locale, entry.cause) : (ACTION_CAUSES as readonly string[]).includes(entry.cause) ? actionTemplate(locale, entry.cause) : c.action(codeOf(entry.cause));
    case 'finished': {
      const e: TimelineFinished = entry;
      if (e.outcome === 'conformant' && e.strategy !== null) {
        const code = EXECUTION_CODE[e.strategy.execution] ?? '';
        return c.strategy(pathLabel(e.strategy), code, fmtUsd(e.strategy.est_cost_usd, locale));
      }
      if (e.outcome === 'stopped') return c.stopped(codeOrNull(e.stop_reason));
      if (e.outcome === 'budget_exhausted') return c.budget;
      if (e.outcome === 'cancelled') return c.cancelled;
      return c.failed(codeOrNull(e.failure_class));
    }
    default:
      return null;
  }
}

/** Dossier d'enquête : accusé, puis un état par indice (huit au plus), coupe-circuit et questions ouvertes. Aucun texte du dossier. */
function briefLines(brief: BriefNarrative, locale: McpLocale): { head: string; body: string[] } {
  const b = narrativeCatalog(locale).brief;
  const usable = brief.report.filter((r) => BRIEF_ID.test(r.id) && BRIEF_KINDS.includes(r.kind) && r.state in b.states);
  const body = usable.slice(0, BRIEF_MAX_LINES).map((r) => `   ${b.line(r.id, r.kind, b.states[r.state]!, typeof r.reason_code === 'string' && REASON_CODE.test(r.reason_code) ? r.reason_code : '')}`);
  if (usable.length > BRIEF_MAX_LINES) body.push(`   ${b.more(usable.length - BRIEF_MAX_LINES)}`);
  if (brief.breaker === true) body.push(`   ${b.breaker}`);
  if (typeof brief.open_questions === 'number' && brief.open_questions > 0) body.push(`   ${b.questions(brief.open_questions)}`);
  return { head: b.read(brief.hints, brief.tried), body };
}

/** Le récit complet : en-tête, une ligne par étape, jalons, coût, stratégie, prochaine étape, console. */
export function renderNarrative(input: NarrativeInput, locale: McpLocale): string {
  const c = narrativeCatalog(locale);
  const start = input.timeline.find((e) => e.kind === 'investigation');
  const lines: string[] = [];
  const brief = input.brief === undefined ? null : briefLines(input.brief, locale);
  if (brief !== null) lines.push(brief.head);
  if (start !== undefined && start.kind === 'investigation') lines.push(c.title(start.slug, hostOrNull(start.domain), codeOf(start.phase)));
  for (const entry of input.timeline) {
    const text = entryText(entry, locale);
    if (text === null) continue;
    if (entry.step !== null && entry.step > 0) lines.push(`${entry.step}. ${text}`);
    else lines.push(entry.kind === 'schema' || entry.kind === 'pruned' ? `   ${text}` : text);
    // Les états des indices suivent le rapport d'accès : le dossier est lu avant la reconnaissance.
    if (entry.kind === 'access_report' && brief !== null) lines.push(...brief.body);
  }
  const finished = input.timeline.some((e) => e.kind === 'finished');
  if (!finished && ACTIVE.has(input.state)) lines.push(c.running);
  lines.push(`${c.costWord}${locale === 'fr' ? ' : ' : ': '}${fmtUsd(input.totalUsd, locale)}`);
  lines.push(nextLine(input, locale));
  lines.push(`${c.console}${locale === 'fr' ? ' : ' : ': '}${input.consoleUrl}`);
  return lines.join('\n');
}

function nextLine(input: NarrativeInput, locale: McpLocale): string {
  const c = narrativeCatalog(locale).next;
  if (input.schemaRemark === true) return c.schemaRemark;
  const tool = input.nextAction?.tool ?? null;
  if (tool === 'validate_schema') return c.validate;
  if (tool === 'get_run') return c.poll(input.pollAfterSeconds);
  if (tool === 'get_items') return c.items;
  const start = input.timeline.find((e) => e.kind === 'investigation');
  const done = input.timeline.some((e) => e.kind === 'finished' && e.outcome === 'conformant');
  if (done && start?.kind === 'investigation') return `${c.run(apiToolName(start.slug) ?? 'run_api')} ${narrativeCatalog(locale).header.restart}`;
  return c.none;
}

/** `attempts[]` de `structuredContent` : les essais de la chronologie, mêmes valeurs que le récit. */
export type AttemptView = Omit<TimelineAttempt, 'kind' | 'step'> & { index: number };
export function attemptsOf(timeline: readonly TimelineEntry[]): AttemptView[] {
  return timeline
    .filter((e): e is TimelineAttempt => e.kind === 'attempt')
    .map((e) => ({ index: e.step, execution: e.execution, network: e.network, result: e.result, records: e.records, pages: e.pages, est_cost_usd: e.est_cost_usd, cost_usd: e.cost_usd, ms: e.ms }));
}
