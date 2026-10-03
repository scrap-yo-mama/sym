// SPDX-License-Identifier: AGPL-3.0-only
// Ce que SYM 👻 répond (tâche 2.14, 19c § 7) : `brief_report[]` (faits du code) et récit à gabarits FERMÉS
// `narrative.brief.*` en `en` et `fr` (20 § 3.3 ; voix relue par 3.19, catalogue rangé dans `packages/i18n` par 3.20).
// RIEN du texte du dossier n'est recopié : comptes, identifiants d'indices (`h1`), types et états du code, gabarits d'URL
// reconstruits par le code (hôte et début de chemin, 60 caractères, segments variables ou identifiants en `{param}`).
// Le condensé de reprise (`get_api(view: "iteration")`, ressource, `resume_api` : exposés par 3.14) suit la même règle.
import type { BriefHintKind, BriefHintState, BriefReason } from './schema.js';
import { BRIEF_DEFAULTS } from './schema.js';
import type { FinalHint, HintProvenance } from './apply.js';
import { displayTemplate } from './url.js';

export type BriefReportEntry = {
  readonly id: string;
  readonly kind: BriefHintKind;
  readonly state: BriefHintState;
  readonly reason: BriefReason | null;
  readonly provenance: HintProvenance | null;
  /** Gabarit reconstruit par le code (`host/path/{param}`), jamais la valeur reçue ; `null` hors indices URL. */
  readonly template: string | null;
  readonly stale: boolean;
  readonly cost_usd: number | null;
};

export type BriefSummary = {
  readonly hints: number;
  readonly tried: number;
  readonly open_questions: number;
  readonly breaker_open: boolean;
  readonly brief_version: number | null;
};

const ID = /^[a-z0-9_-]{1,16}$/;

/** Entrées du rapport : identifiants validés par le schéma, codes, gabarits reconstruits. */
export function briefReport(hints: readonly FinalHint[]): BriefReportEntry[] {
  return hints.map((h) => ({
    id: ID.test(h.id) ? h.id : 'h',
    kind: h.kind,
    state: h.state,
    reason: h.reason,
    provenance: h.provenance,
    template: h.url === null ? null : displayTemplate(h.url),
    stale: h.stale,
    cost_usd: h.probe?.cost_usd ?? null,
  }));
}

export type NarrativeLocale = 'en' | 'fr';

/** Gabarits fermés `narrative.brief.*` (20 § 3.3) : aucun verbe de contournement, aucune promesse d'invisibilité. */
export const BRIEF_NARRATIVE: Readonly<Record<NarrativeLocale, Readonly<Record<string, string>>>> = {
  fr: {
    'narrative.brief.read': 'SYM 👻 : J’ai lu ton dossier : {hints} indices, {tried} essais déjà faits. Je vérifie chaque indice avant de m’y fier.',
    'narrative.brief.step': 'Dossier : {done} indices vérifiés sur {hints}',
    'narrative.brief.hint': '{id} {kind} : {state}',
    'narrative.brief.hint_template': '{id} {kind} ({template}) : {state}',
    'narrative.brief.more': '… et {n} autres, dans la console.',
    'narrative.brief.breaker': 'SYM 👻 : Deux indices ont échoué : je continue sans ton dossier.',
    'narrative.brief.questions': '{n} questions de ton IA attendent dans la console.',
    'narrative.brief.kind.endpoint': 'point d’accès',
    'narrative.brief.kind.embedded_data': 'données embarquées',
    'narrative.brief.kind.selector': 'sélecteur',
    'narrative.brief.kind.pagination': 'pagination',
    'narrative.brief.kind.example_url': 'URL d’exemple',
    'narrative.brief.kind.pitfall': 'piège',
    'narrative.brief.reason.brief_used': 'vérifié et utilisé',
    'narrative.brief.reason.brief_verified_unused': 'vérifié, une stratégie moins chère a été retenue',
    'narrative.brief.reason.brief_probe_failed': 'vérification en échec, indice écarté',
    'narrative.brief.reason.brief_stale': 'ancien, non vérifié',
    'narrative.brief.reason.brief_unverifiable': 'lu comme indication, non vérifiable',
    'narrative.brief.reason.brief_host_ignored': 'autre site que l’API : ignoré, l’accès reste celui de l’API',
    'narrative.brief.reason.brief_robots_skipped': 'chemin interdit par robots.txt : ignoré, aucune requête',
    'narrative.brief.reason.brief_duplicate': 'doublon d’un autre indice',
    'narrative.brief.reason.brief_invalid_item': 'valeur hors du format de son type : ignoré',
    'narrative.brief.reason.brief_over_budget': 'au-delà du plafond de vérification : non vérifié',
    'narrative.brief.reason.brief_widening_ignored': 'consigne sans effet : les règles d’accès restent fixées dans le code',
    'narrative.brief.reason.brief_breaker_open': 'non vérifié : je continue sans ton dossier',
    'narrative.brief.reason.brief_subject_excluded': 'concerne une personne qui a demandé l’effacement : ignoré',
    'narrative.brief.reason.none': 'en attente de vérification',
  },
  en: {
    'narrative.brief.read': 'SYM 👻: I read your brief: {hints} hints, {tried} tries already made. I check each hint before relying on it.',
    'narrative.brief.step': 'Brief: {done} of {hints} hints checked',
    'narrative.brief.hint': '{id} {kind}: {state}',
    'narrative.brief.hint_template': '{id} {kind} ({template}): {state}',
    'narrative.brief.more': '… and {n} more, in the console.',
    'narrative.brief.breaker': 'SYM 👻: Two hints failed: I carry on without your brief.',
    'narrative.brief.questions': '{n} questions from your AI are waiting in the console.',
    'narrative.brief.kind.endpoint': 'endpoint',
    'narrative.brief.kind.embedded_data': 'embedded data',
    'narrative.brief.kind.selector': 'selector',
    'narrative.brief.kind.pagination': 'pagination',
    'narrative.brief.kind.example_url': 'example URL',
    'narrative.brief.kind.pitfall': 'pitfall',
    'narrative.brief.reason.brief_used': 'checked and used',
    'narrative.brief.reason.brief_verified_unused': 'checked, a cheaper strategy was kept',
    'narrative.brief.reason.brief_probe_failed': 'check failed, hint set aside',
    'narrative.brief.reason.brief_stale': 'old, not checked',
    'narrative.brief.reason.brief_unverifiable': 'read as a pointer, cannot be checked',
    'narrative.brief.reason.brief_host_ignored': 'another site than the API: ignored, access stays the API’s',
    'narrative.brief.reason.brief_robots_skipped': 'path disallowed by robots.txt: ignored, no request',
    'narrative.brief.reason.brief_duplicate': 'duplicate of another hint',
    'narrative.brief.reason.brief_invalid_item': 'value outside the format of its kind: ignored',
    'narrative.brief.reason.brief_over_budget': 'beyond the check limit: not checked',
    'narrative.brief.reason.brief_widening_ignored': 'no effect: access rules stay fixed in the code',
    'narrative.brief.reason.brief_breaker_open': 'not checked: I carry on without your brief',
    'narrative.brief.reason.brief_subject_excluded': 'about a person who asked to be erased: ignored',
    'narrative.brief.reason.none': 'waiting to be checked',
  },
};

const fill = (template: string, params: Readonly<Record<string, string | number>>) => template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''));

/**
 * Récit du dossier (19c § 7) : ligne d'accusé, une ligne par indice (huit au plus, puis « … et N autres »), coupe-circuit,
 * questions ouvertes signalées sans leur texte. Sans dossier : aucune ligne (`[]`).
 */
export function briefNarrative(report: readonly BriefReportEntry[], summary: BriefSummary, locale: NarrativeLocale = 'en'): string[] {
  if (summary.hints === 0 && summary.tried === 0 && summary.open_questions === 0 && report.length === 0) return [];
  const t = BRIEF_NARRATIVE[locale];
  const lines = [fill(t['narrative.brief.read']!, { hints: summary.hints, tried: summary.tried })];
  const max = BRIEF_DEFAULTS.narrativeMaxHints;
  for (const entry of report.slice(0, max)) {
    const kind = t[`narrative.brief.kind.${entry.kind}`]!;
    const state = t[`narrative.brief.reason.${entry.reason ?? 'none'}`] ?? t['narrative.brief.reason.none']!;
    lines.push(entry.template === null ? fill(t['narrative.brief.hint']!, { id: entry.id, kind, state }) : fill(t['narrative.brief.hint_template']!, { id: entry.id, kind, template: entry.template, state }));
  }
  if (report.length > max) lines.push(fill(t['narrative.brief.more']!, { n: report.length - max }));
  if (summary.breaker_open) lines.push(t['narrative.brief.breaker']!);
  if (summary.open_questions > 0) lines.push(fill(t['narrative.brief.questions']!, { n: summary.open_questions }));
  return lines;
}

/**
 * Condensé de reprise (19c § 4) : construit par le code, sans aucun texte libre du dossier (ni `notes`, ni `pitfall`, ni
 * `tried.note`, ni `open_questions`, ni `value` brut) ; 300 jetons au plus.
 */
export function briefResumeDigest(report: readonly BriefReportEntry[], summary: BriefSummary): { readonly text: string; readonly tokens: number } {
  const head = `brief v${summary.brief_version ?? '?'}: ${summary.hints} hints, ${summary.tried} tries, ${summary.open_questions} open questions`;
  const lines = [head];
  for (const e of report) {
    const line = `${e.id} ${e.kind} ${e.state}${e.reason === null ? '' : ` ${e.reason}`}${e.template === null ? '' : ` ${e.template}`}`;
    if (Math.ceil([...lines, line].join('\n').length / 4) > BRIEF_DEFAULTS.resumeMaxTokens) break;
    lines.push(line);
  }
  const text = lines.join('\n');
  return { text, tokens: Math.ceil(text.length / 4) };
}

/** Charge de journal d'un dossier (`brief.read`) : empreinte, tailles, comptes ; JAMAIS le contenu (assert_brief_not_logged). */
export function briefLogPayload(args: { readonly sha256: string; readonly bytes: number; readonly version: number | null; readonly hints: readonly { readonly id: string; readonly kind: string; readonly state?: string; readonly reason?: string | null }[]; readonly tried: number; readonly open_questions: number }): Record<string, unknown> {
  return {
    sha256: args.sha256,
    bytes: args.bytes,
    version: args.version,
    tried: args.tried,
    open_questions: args.open_questions,
    hints: args.hints.map((h) => ({ id: ID.test(h.id) ? h.id : 'h', kind: h.kind, ...(h.state === undefined ? {} : { state: h.state }), ...(h.reason === undefined || h.reason === null ? {} : { reason: h.reason }) })),
  };
}
