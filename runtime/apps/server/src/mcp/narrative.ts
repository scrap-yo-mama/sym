// SPDX-License-Identifier: AGPL-3.0-only
// Récit de l'enquête (tâche 3.10, 05 § 1.2) : le texte de `content`, rendu depuis les MÊMES entrées de `timeline[]` que
// celles de `structuredContent` (rest/timeline.ts, dérivées de `investigation_events`). Obligatoire : `content` est le
// seul canal garanti dans tous les clients (`assert_text_only_sufficient`) ; le texte et la structure citent les mêmes
// essais et les mêmes coûts (`assert_narrative_matches_structured`).
//
// Gabarits fermés (texts.ts) : jamais un texte du site ni du dossier d'enquête (seul l'aperçu des éléments rendus par SYM, cité
// comme donnée, porte des valeurs du site). Mots simples (U1.8, 03-specs-mcp § 5) : quatre jalons « 1/4 Décrire » à « 4/4 Extraire »,
// aucun code interne dans le texte humain (les codes restent dans `structuredContent`), signature de SYM en tête et en fin de succès. Le dossier (19c § 7) n'entre que par des
// identifiants validés (`h1`), des types et des états du code ; huit lignes d'indices au plus.
//
// Cause nommée (UX-04) : un run arrêté par une cause connue (`instance_contact_missing`, `llm_price_missing`…) la porte dans
// `error` de l'enveloppe (`error_detail` du run), pas dans `failure_class` (NULL). Le récit la reçoit en entrée et la dit,
// avec son gabarit fermé, même quand la chronologie n'a ni action requise ni événement de fin.
import { isTerminalRunState, type RunState } from '@runtime/core';
import { codeOf, codeOrNull, hostOrNull, schemaValidatedEntry, type TimelineAttempt, type TimelineEntry, type TimelineFinished } from '../rest/timeline.js';
import { defaultI18n } from '@runtime/i18n';
import { errorNeedsParams, errorTexts, hasErrorCode } from '../error-catalog.js';
import {
  ACTION_CAUSES,
  actionTemplate,
  BLOCKED_CAUSES,
  blockedTemplate,
  fmtSeconds,
  fmtUsd,
  methodWords,
  narrativeCatalog,
  symSignature,
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
  /** Cause nommée d'un run arrêté (`error` de l'enveloppe RunResult ou de `ApiCreated`, UX-04) : seul son code est lu. */
  error?: { code?: unknown } | null;
  /** Éléments rendus par SYM (succès) : total et aperçu ; sans eux, la fin chiffrée n'a pas de tableau. */
  result?: NarrativeResult;
};

/** Aperçu des éléments rendus : total, dix premiers (tableau Markdown de 6 colonnes au plus), valeurs citées comme données. */
type NarrativeResult = { total: number | null; preview: readonly Record<string, unknown>[] };

/** Lignes d'un jalon au plus 80 caractères (03-specs-mcp § 5). */
const MILESTONE_MAX_CHARS = 80;
export const PREVIEW_MAX_ROWS = 10;
const PREVIEW_MAX_COLUMNS = 6;

const BRIEF_KINDS = ['endpoint', 'embedded_data', 'selector', 'pagination', 'example_url', 'pitfall'];
const BRIEF_ID = /^[a-z0-9_-]{1,16}$/;
const REASON_CODE = /^[a-z][a-z0-9_]{0,39}$/;
/** Lignes d'indices au plus (19c § 7), puis « … et N autres, dans la console ». */
export const BRIEF_MAX_LINES = 8;

const ACTIVE = new Set(['queued', 'running', 'waiting_tunnel']);

/**
 * Le générateur filtre lui-même chaque code qu'il lit (cause, stop_reason, failure_class, result, raison d'élagage, mode, phase) :
 * forme d'un code, sinon `unknown` ; domaine : forme d'un nom d'hôte, sinon rien. La chronologie applique déjà ces filtres
 * (rest/timeline.ts) ; le récit ne compte pas sur elle : une entrée venue d'ailleurs n'y glisse aucun texte. Aucun code n'est
 * recopié dans le texte humain : il devient des mots (`wordsOf`) ou disparaît.
 */

/** Code de la cause nommée (UX-04) s'il a la forme d'un code, sinon null : une valeur reçue n'est jamais recopiée. */
const causeOf = (error: NarrativeInput['error']): string | null => {
  const code = error?.code;
  return typeof code === 'string' && REASON_CODE.test(code) ? code : null;
};

const isAction = (cause: string | null): cause is string => cause !== null && (ACTION_CAUSES as readonly string[]).includes(cause);

/** Jalon (1 à 4) d'une entrée de la chronologie : décrire, reconnaître, valider le schéma, extraire ; null pour les autres. */
function milestoneOf(entry: TimelineEntry): 1 | 2 | 3 | 4 | null {
  switch (entry.kind) {
    case 'access_report':
      return 1;
    case 'reconnaissance':
      return 2;
    case 'schema':
      return 3;
    case 'attempt':
    case 'pruned':
      return 4;
    case 'finished':
      return entry.outcome === 'conformant' && entry.strategy !== null ? 4 : null;
    default:
      return null;
  }
}

/**
 * Libellé humain d'un code du worker (classe d'échec, résultat d'un essai, cause) : le texte du catalogue (`failureClass.*`,
 * `srv.error.*`), jamais le code. Null si aucun texte ne le connaît : la phrase se passe alors de cause.
 */
function wordsOf(code: string | null, locale: McpLocale): string | null {
  if (code === null || code === 'unknown') return null;
  const { renderer } = defaultI18n();
  const key = `failureClass.${code}`;
  if (renderer.has(key, 'en')) return lowerFirst(renderer.render(key as never, { code: '' }, locale).replace(/\s*\(\)$/, ''));
  if (hasErrorCode(code) && !errorNeedsParams(code)) return lowerFirst(errorTexts(code, locale).message ?? '').replace(/\.$/, '') || null;
  return null;
}
const lowerFirst = (text: string): string => (text === '' ? text : `${text.charAt(0).toLowerCase()}${text.slice(1)}`);

/** Coupe une ligne de jalon à 80 caractères (point de suspension), sans toucher à sa fin (durée et coût). */
function fit(head: string, tail: string): string {
  const room = MILESTONE_MAX_CHARS - tail.length - 1;
  const text = head.length <= room ? head : `${head.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
  return `${text} ${tail}`;
}

/** Détail d'une entrée en mots simples (sans le préfixe du jalon), ou null. `cause` : cause nommée du run (UX-04). */
function entryDetail(entry: TimelineEntry, locale: McpLocale, cause: string | null): string | null {
  const c = narrativeCatalog(locale);
  switch (entry.kind) {
    case 'access_report':
      return entry.signal === null ? c.access.unknown : c.access[entry.signal];
    case 'reconnaissance':
      return entry.failure_class === null ? c.recon(entry.sources) : c.reconFailed(wordsOf(codeOf(entry.failure_class), locale));
    case 'attempt': {
      const why = entry.result === 'ok' || entry.why === undefined || entry.why === null ? null : c.why(codeOf(entry.why.code), codeOrNull(entry.why.reason));
      const result = entry.result === 'ok' ? null : wordsOf(codeOf(entry.result), locale);
      const trial = c.trial(methodWords(entry.execution, entry.network, locale), entry.result === 'ok', result, entry.records, entry.pages);
      return why === null ? trial : `${trial} — ${why}`;
    }
    case 'schema':
      return c.schema(entry.ok, entry.fields);
    case 'schema_validated':
      return c.validated(entry);
    case 'pruned':
      return entry.count === 0 ? null : c.pruned(entry.by === null ? null : methodWords(entry.by.execution, entry.by.network, locale), entry.count);
    case 'action_required':
      return (BLOCKED_CAUSES as readonly string[]).includes(entry.cause) ? blockedTemplate(locale, entry.cause) : (ACTION_CAUSES as readonly string[]).includes(entry.cause) ? actionTemplate(locale, entry.cause) : c.action;
    case 'finished': {
      const e: TimelineFinished = entry;
      if (e.outcome === 'conformant' && e.strategy !== null) return c.kept(methodWords(e.strategy.execution, e.strategy.network, locale), fmtUsd(e.strategy.est_cost_usd, locale));
      if (e.outcome === 'stopped') {
        const reason = codeOrNull(e.stop_reason) ?? cause;
        return isAction(reason) ? c.stoppedAction : c.stopped;
      }
      if (e.outcome === 'budget_exhausted') return c.budget;
      if (e.outcome === 'cancelled') return c.cancelled;
      return c.failed(wordsOf(codeOrNull(e.failure_class) ?? cause, locale));
    }
    default:
      return null;
  }
}

/** « 2/4 Reconnaître » : le préfixe d'un jalon. */
const milestonePrefix = (n: 1 | 2 | 3 | 4, locale: McpLocale): string => `${n}/4 ${narrativeCatalog(locale).milestones[n - 1]}${locale === 'fr' ? ' :' : ':'}`;

/**
 * Texte d'une étape ou d'un jalon, pour la progression MCP : « 2/4 Reconnaître : 1 source de données candidate trouvée », 80
 * caractères au plus ; les entrées hors jalon (action requise, fin) gardent leur phrase.
 */
export function entryText(entry: TimelineEntry, locale: McpLocale, cause: string | null = null): string | null {
  // Un essai, en progression : la méthode et son verdict seulement (les éléments et les pages sont dans le récit).
  const detail = entry.kind === 'attempt' ? narrativeCatalog(locale).trial(methodWords(entry.execution, entry.network, locale), entry.result === 'ok', entry.result === 'ok' ? null : wordsOf(codeOf(entry.result), locale), null, null) : entryDetail(entry, locale, cause);
  if (detail === null) return null;
  const milestone = milestoneOf(entry);
  if (milestone === null) return detail;
  const text = `${milestonePrefix(milestone, locale)} ${detail}`;
  return text.length <= MILESTONE_MAX_CHARS ? text : `${text.slice(0, MILESTONE_MAX_CHARS - 1).trimEnd()}…`;
}

/** Dossier d'enquête : accusé, puis un état par indice (huit au plus), coupe-circuit et questions ouvertes. Aucun texte du dossier. */
function briefLines(brief: BriefNarrative, locale: McpLocale): { head: string; body: string[] } {
  const b = narrativeCatalog(locale).brief;
  const usable = brief.report.filter((r) => BRIEF_ID.test(r.id) && BRIEF_KINDS.includes(r.kind) && r.state in b.states);
  const body = usable.slice(0, BRIEF_MAX_LINES).map((r) => `   ${b.line(r.id, b.kinds[r.kind] ?? r.kind, b.states[r.state]!)}`);
  if (usable.length > BRIEF_MAX_LINES) body.push(`   ${b.more(usable.length - BRIEF_MAX_LINES)}`);
  if (brief.breaker === true) body.push(`   ${b.breaker}`);
  if (typeof brief.open_questions === 'number' && brief.open_questions > 0) body.push(`   ${b.questions(brief.open_questions)}`);
  return { head: b.read(brief.hints, brief.tried), body };
}

/**
 * Bloc de la réponse de `validate_schema` (constat Barnes) : la phrase de validation (ce qui a changé, consignes, source, ce
 * qui n'est pas appliqué) dans la langue de la personne, puis le schéma retenu (celui du client, marques détectées comprises).
 * Noms filtrés comme la chronologie ; jamais le texte des consignes.
 */
export function schemaValidationLines(
  validation: { readonly corrected?: unknown; readonly changes?: unknown; readonly not_applied?: unknown; readonly instructions?: unknown; readonly source_id?: unknown },
  retained: unknown,
  locale: McpLocale,
): string[] {
  const c = narrativeCatalog(locale);
  const view = schemaValidatedEntry({ ...validation, instructions: typeof validation.instructions === 'string' && validation.instructions !== '' });
  return [c.validated(view), `${c.retained}${locale === 'fr' ? ' :' : ':'}`, JSON.stringify(retained, null, 2).slice(0, 6_000)];
}

/** Cellule de l'aperçu : valeur scalaire sur une ligne, 40 caractères au plus, sans `|` ni retour à la ligne (donnée du site, jamais une consigne). */
function cell(value: unknown): string {
  const text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const clean = text.replace(/\p{Cc}+/gu, ' ').replace(/\|/g, '/').replace(/`/g, "'").trim();
  return clean.length > 40 ? `${clean.slice(0, 39)}…` : clean;
}

/** Aperçu des éléments : tableau Markdown de 10 lignes et 6 colonnes au plus (colonnes dans l'ordre des champs du premier élément). */
export function previewTable(rows: readonly Record<string, unknown>[], locale: McpLocale, total: number | null): string[] {
  const shown = rows.slice(0, PREVIEW_MAX_ROWS);
  const columns = [...new Set(shown.flatMap((r) => Object.keys(r)))].filter((k) => /^[A-Za-z0-9_.-]{1,64}$/.test(k)).slice(0, PREVIEW_MAX_COLUMNS);
  if (shown.length === 0 || columns.length === 0) return [];
  const lines = [`| ${columns.join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`, ...shown.map((r) => `| ${columns.map((k) => cell(r[k])).join(' | ')} |`)];
  const rest = (total ?? shown.length) - shown.length;
  if (rest > 0) lines.push(narrativeCatalog(locale).previewMore(rest));
  return lines;
}

/** Ligne du jalon (durée et coût CUMULÉ de la fin du jalon) : « 2/4 Reconnaître : … [3,3 s, 0,002 $] », 80 caractères au plus. */
function milestoneLine(n: 1 | 2 | 3 | 4, detail: string, ms: number | null, cumulativeUsd: number, locale: McpLocale): string {
  const tail = ms === null ? `[${fmtUsd(cumulativeUsd, locale)}]` : `[${fmtSeconds(ms, locale)}, ${fmtUsd(cumulativeUsd, locale)}]`;
  return fit(`${milestonePrefix(n, locale)} ${detail}`, tail);
}

/**
 * Le récit complet : prise en charge, en-tête, quatre jalons (les essais en sous-lignes du jalon 4), coût, fin chiffrée avec
 * aperçu, prochaine étape, console. Les échecs, arrêts et refus restent neutres : ni prise en charge ni fin de succès.
 */
export function renderNarrative(input: NarrativeInput, locale: McpLocale): string {
  const c = narrativeCatalog(locale);
  const start = input.timeline.find((e) => e.kind === 'investigation');
  const lines: string[] = [];
  const cause = causeOf(input.error);
  const brief = input.brief === undefined ? null : briefLines(input.brief, locale);
  const finishedEntry = input.timeline.find((e): e is TimelineFinished => e.kind === 'finished');
  const succeeded = finishedEntry?.outcome === 'conformant' && finishedEntry.strategy !== null;
  // Neutre sur un échec, un arrêt, un refus ou une action attendue ; la signature de SYM ne parle qu'en prenant en charge et en réussissant.
  const neutral = cause !== null || (finishedEntry !== undefined && !succeeded) || input.timeline.some((e) => e.kind === 'action_required') || input.state === 'failed';
  // Le dossier, quand il y en a un, ouvre le récit avec sa propre phrase signée (« SYM 👻 : J'ai lu ton dossier… »).
  if (brief !== null) lines.push(brief.head);
  else if (!neutral) lines.push(`${symSignature(locale)} ${c.takeOver}`);
  if (start !== undefined && start.kind === 'investigation') lines.push(c.title(start.slug, hostOrNull(start.domain)));
  let spent = 0;
  // Jalon 4 : un résumé, puis les essais en sous-lignes ; les ligne des jalons 1 à 3 portent leur durée et le coût cumulé.
  let tried = 0;
  let kept: string | null = null;
  let extractMs = 0;
  let extractStart = -1;
  let spentBeforeExtract = 0;
  const hasSchema = input.timeline.some((e) => e.kind === 'schema');
  const flushExtract = () => {
    if (extractStart < 0) return;
    const summary = c.extract(tried, kept);
    const head = milestoneLine(4, summary, extractMs, spent, locale);
    // Un run dont le schéma était déjà validé ne le repropose pas : le jalon 3 le dit, pour que les quatre jalons restent les mêmes partout.
    lines.splice(extractStart, 0, ...(hasSchema ? [] : [milestoneLine(3, c.schemaValidated, null, spentBeforeExtract, locale)]), head);
    extractStart = -1;
  };
  for (const entry of input.timeline) {
    const milestone = milestoneOf(entry);
    if ('cost_usd' in entry) spent += entry.cost_usd;
    const detail = entryDetail(entry, locale, cause);
    if (detail === null) continue;
    if (milestone === 4) {
      if (extractStart < 0) {
        extractStart = lines.length;
        spentBeforeExtract = spent - ('cost_usd' in entry ? entry.cost_usd : 0);
      }
      if (entry.kind === 'attempt') {
        tried += 1;
        extractMs += entry.ms ?? 0;
        lines.push(`   ${detail} [${fmtSeconds(entry.ms, locale)}, ${fmtUsd(entry.cost_usd, locale)}]`);
      } else {
        if (entry.kind === 'finished' && entry.strategy !== null) kept = methodWords(entry.strategy.execution, entry.strategy.network, locale);
        lines.push(`   ${detail}`);
      }
      continue;
    }
    // Un jalon qui suit l'extraction la clôt avant lui (ordre normal : 1, 2, 3, 4).
    flushExtract();
    if (milestone !== null && entry.kind !== 'schema') lines.push(milestoneLine(milestone, detail, 'ms' in entry ? entry.ms : null, spent, locale));
    else if (entry.kind === 'schema') lines.push(milestoneLine(3, detail, null, spent, locale));
    else lines.push(detail);
    // Les états des indices suivent le rapport d'accès : le dossier est lu avant la reconnaissance.
    if (entry.kind === 'access_report' && brief !== null) lines.push(...brief.body);
  }
  flushExtract();
  const finished = finishedEntry !== undefined;
  // Cause nommée sans événement de fin (run arrêté avant l'étape 0, ou fin non journalisée) : l'échec et sa cause.
  if (cause !== null && !finished) lines.push(c.failed(wordsOf(cause, locale)));
  // Son gabarit fermé, s'il n'a pas déjà été dit par l'action requise de la chronologie.
  if (isAction(cause) && !input.timeline.some((e) => e.kind === 'action_required' && e.cause === cause)) lines.push(actionTemplate(locale, cause));
  if (!finished && cause === null && ACTIVE.has(input.state)) lines.push(c.running);
  lines.push(`${c.costWord}${locale === 'fr' ? ' : ' : ': '}${fmtUsd(input.totalUsd, locale)}`);
  // Fin chiffrée (succès) : signature, éléments et coût d'un rejeu, puis l'aperçu.
  if (succeeded && finishedEntry.strategy !== null) {
    const items = input.result?.total ?? finishedEntry.items;
    lines.push(`${symSignature(locale)} ${c.done(items, fmtUsd(finishedEntry.strategy.est_cost_usd, locale))}`);
    if (input.result !== undefined) lines.push(...previewTable(input.result.preview, locale, input.result.total));
  }
  lines.push(nextLine(input, locale, { cause, outcome: finishedEntry?.outcome ?? null, stopReason: finishedEntry === undefined ? null : codeOrNull(finishedEntry.stop_reason), action: input.timeline.some((e) => e.kind === 'action_required') }));
  lines.push(`${c.console}${locale === 'fr' ? ' : ' : ': '}${input.consoleUrl}`);
  return lines.join('\n');
}

/** Arguments de `next_action` cités par le récit, dans cet ordre ; chacun garde sa forme (uuid, curseur opaque) ou n'est pas cité. */
const NEXT_ARGS: readonly (readonly [string, RegExp])[] = [
  ['api_id', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ['run_id', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ['dataset_id', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i],
  ['cursor', /^[A-Za-z0-9_.~=-]{1,512}$/],
];

/**
 * Les identifiants de la prochaine action, en texte (« api_id <uuid> », « dataset_id <uuid> and cursor <c> ») : un client
 * qui n'affiche que `content` doit pouvoir faire l'appel suivant (assert_text_only_sufficient). Null si aucun n'a sa forme.
 */
function nextArgsText(nextAction: NarrativeInput['nextAction'], locale: McpLocale): string | null {
  const args = nextAction?.args;
  if (typeof args !== 'object' || args === null) return null;
  const parts: string[] = [];
  for (const [key, shape] of NEXT_ARGS) {
    const value = (args as Record<string, unknown>)[key];
    if (typeof value === 'string' && shape.test(value)) parts.push(`${key} ${value}`);
  }
  return parts.length === 0 ? null : parts.join(locale === 'fr' ? ' et ' : ' and ');
}

function nextLine(input: NarrativeInput, locale: McpLocale, end: { cause: string | null; outcome: string | null; stopReason: string | null; action: boolean }): string {
  const c = narrativeCatalog(locale).next;
  const ids = nextArgsText(input.nextAction, locale);
  const tool = input.nextAction?.tool ?? null;
  if (input.schemaRemark === true) return c.schemaRemark(tool === 'validate_schema' ? ids : null);
  if (tool === 'validate_schema') return c.validate(ids);
  if (tool === 'get_run') return c.poll(input.pollAfterSeconds, ids);
  if (tool === 'get_items') return c.items(ids);
  const start = input.timeline.find((e) => e.kind === 'investigation');
  const done = input.timeline.some((e) => e.kind === 'finished' && e.outcome === 'conformant');
  if (done && start?.kind === 'investigation') return `${c.run(apiToolName(start.slug) ?? 'run_api')} ${narrativeCatalog(locale).header.restart}`;
  // Fin sans succès : la suite que SYM propose (refus du site, action à faire, échec), jamais « aucune ».
  const blocked = [end.stopReason, end.cause].some((r) => r !== null && (BLOCKED_CAUSES as readonly string[]).includes(r)) || input.timeline.some((e) => e.kind === 'action_required' && (BLOCKED_CAUSES as readonly string[]).includes(e.cause));
  if (blocked) return c.blocked;
  if (end.action || isAction(end.cause) || isAction(end.stopReason)) return c.action;
  if (end.outcome !== null || input.state === 'failed' || end.cause !== null) return c.failed;
  return c.none;
}

/**
 * Phrase de `create_api` selon l'état RÉEL de l'enquête (UX-07), pour le modèle (en anglais, 21 § 4.3) : schéma à valider,
 * échec avec sa cause nommée (UX-04), fin sans schéma, ou en cours. Jamais « running » quand le run est terminé, ni « done »
 * sans dire ce qui s'est passé. Elle ouvre le texte de `create_api`, avant le récit.
 */
export function createdSummary(created: Record<string, unknown>): string {
  const slug = String(created['slug']);
  const phase = created['investigation_phase'];
  const runState = created['run_state'];
  const status = typeof created['status'] === 'string' ? created['status'] : null;
  const error = created['error'] as { code?: unknown; message?: unknown } | undefined;
  if (phase === 'awaiting_schema_validation') return `API ${slug} created. Proposed output schema below: show it to the user, then call validate_schema with api_id.`;
  if (runState === 'failed') {
    const cause = typeof error?.code === 'string' ? ` (${error.code}): ${String(error.message ?? '')}` : '; read get_run with run_id for the cause.';
    return `API ${slug} created, but the investigation failed${cause}${status === null ? '' : ` The API is now ${status}.`}`;
  }
  if (typeof runState === 'string' && isTerminalRunState(runState as RunState)) {
    return `API ${slug} created; the investigation ended (${runState})${status === null ? '' : `, the API is now ${status}`}: read get_run with run_id.`;
  }
  return `API ${slug} created; the investigation is running: poll get_run with run_id, then validate the proposed schema.`;
}

/** `attempts[]` de `structuredContent` : les essais de la chronologie, mêmes valeurs que le récit. */
export type AttemptView = Omit<TimelineAttempt, 'kind' | 'step'> & { index: number };
export function attemptsOf(timeline: readonly TimelineEntry[]): AttemptView[] {
  return timeline
    .filter((e): e is TimelineAttempt => e.kind === 'attempt')
    .map((e) => ({ index: e.step, execution: e.execution, network: e.network, result: e.result, records: e.records, pages: e.pages, est_cost_usd: e.est_cost_usd, cost_usd: e.cost_usd, ms: e.ms }));
}
