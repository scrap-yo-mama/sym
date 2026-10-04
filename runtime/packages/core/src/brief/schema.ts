// SPDX-License-Identifier: AGPL-3.0-only
// Dossier d'enquête (`brief`, tâche 2.14, 19c § 2 et § 9.1) : schéma FERMÉ (JSON Schema 2020-12, trois niveaux au plus,
// sans composition ni `$ref`), bornes et variables. Le dossier est une DONNÉE NON FIABLE écrite par l'IA de l'utilisateur :
// aucun champ de garde (hôtes, budget, proxy, en-têtes, cookies, session), aucun statut (`verified`), aucun schéma de sortie.
// Il n'atteint que trois puits : l'ordre des essais (dans l'ensemble autorisé), le prompt d'enquête (section non fiable)
// et l'affichage. Aucun module de politique ne l'importe (`assert_policy_module_no_brief_import`).

/** Types d'indice (19c § 9.1). */
export const BRIEF_HINT_KINDS = ['endpoint', 'embedded_data', 'selector', 'pagination', 'example_url', 'pitfall'] as const;
export type BriefHintKind = (typeof BRIEF_HINT_KINDS)[number];
export const BRIEF_SEEN = ['http_response', 'network_log', 'dom', 'user_said', 'guess'] as const;
export const BRIEF_CONFIDENCE = ['high', 'medium', 'low'] as const;
export const BRIEF_APPROACHES = ['fetch_json', 'fetch_html', 'embedded_data', 'dom_selector', 'browser', 'other'] as const;
export const BRIEF_OUTCOMES = ['ok', 'empty', 'wrong_data', 'error', 'refused', 'unknown'] as const;

export type BriefHint = {
  readonly id: string;
  readonly kind: BriefHintKind;
  readonly value: string;
  readonly seen?: (typeof BRIEF_SEEN)[number];
  readonly seen_on?: string;
  readonly seen_at?: string;
  readonly confidence?: (typeof BRIEF_CONFIDENCE)[number];
  readonly sample?: string;
};

export type BriefTry = {
  readonly approach: (typeof BRIEF_APPROACHES)[number];
  readonly target?: string;
  readonly outcome: (typeof BRIEF_OUTCOMES)[number];
  readonly note?: string;
};

/** Dossier tel que reçu (après validation du schéma fermé). */
export type InvestigationBrief = {
  readonly v?: 1;
  readonly notes?: string;
  readonly hints?: readonly BriefHint[];
  readonly tried?: readonly BriefTry[];
  readonly open_questions?: readonly string[];
};

/**
 * Schéma fermé (19c § 9.1), exposé tel quel dans `inputSchema` de `create_api` (05 § 4.1) : la description du champ dit à
 * toute IA ce que SYM en fait (19c § 8, premier canal). Texte pour le modèle, en anglais (21 § 4.3).
 */
export const BRIEF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  description:
    'Optional. What you already found about this site, as typed hints and what you tried. SYM checks each hint and may ignore it. It never widens access or budgets. No cookies, tokens or personal data. Keep it under 6 KB.',
  properties: {
    v: { const: 1 },
    notes: { type: 'string', maxLength: 2000 },
    hints: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'kind', 'value'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9_-]{1,16}$' },
          kind: { enum: [...BRIEF_HINT_KINDS] },
          value: { type: 'string', maxLength: 300 },
          seen: { enum: [...BRIEF_SEEN] },
          seen_on: { type: 'string', format: 'uri', maxLength: 300 },
          seen_at: { type: 'string', format: 'date-time' },
          confidence: { enum: [...BRIEF_CONFIDENCE] },
          sample: { type: 'string', maxLength: 300 },
        },
      },
    },
    tried: {
      type: 'array',
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['approach', 'outcome'],
        properties: {
          approach: { enum: [...BRIEF_APPROACHES] },
          target: { type: 'string', maxLength: 300 },
          outcome: { enum: [...BRIEF_OUTCOMES] },
          note: { type: 'string', maxLength: 200 },
        },
      },
    },
    open_questions: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 200 } },
  },
};

/** Valeurs par défaut (19c § 9.2 ; propositions de R7, à valider au banc 2.8). */
export const BRIEF_DEFAULTS = Object.freeze({
  /** `BRIEF_MAX_BYTES` : taille UTF-8 au plus, jamais tronquée. */
  maxBytes: 16_000,
  /** Taille recommandée (description du champ). */
  recommendedBytes: 6_000,
  /** `BRIEF_MAX_TOKENS` : budget de la section `<untrusted_agent_brief>` (≈ 4 caractères par jeton). */
  maxTokens: 1_500,
  /** `BRIEF_PROBE_MAX` : indices sondés au plus par enquête. */
  probeMax: 5,
  /** `BRIEF_PROBE_BUDGET_SHARE` : part du budget d'enquête que les sondes peuvent consommer. */
  probeBudgetShare: 0.25,
  /** Coupe-circuit : sondes en échec avant de continuer sans le dossier. */
  breakerFailures: 2,
  /** `BRIEF_NEGATIVE_TTL_DAYS` : mémoire négative d'un indice en échec. */
  negativeTtlDays: 14,
  /** `BRIEF_VERSIONS_KEEP` : versions du dossier gardées par API. */
  versionsKeep: 5,
  /** Condensé de reprise (jetons) : construit par le code, sans texte libre. */
  resumeMaxTokens: 300,
  /** Lignes d'indices du récit au plus. */
  narrativeMaxHints: 8,
  /** Gabarit d'URL affiché ou proposé : caractères au plus. */
  templateMaxChars: 60,
});

/** Péremption par type (jours) : depuis `max(seen_at, dernière sonde réussie)` (19c § 5, durées non mesurées). */
export const BRIEF_STALE_DAYS: Readonly<Record<BriefHintKind, number>> = Object.freeze({
  selector: 30,
  example_url: 30,
  embedded_data: 60,
  endpoint: 90,
  pagination: 90,
  pitfall: 180,
});

export type BriefConfig = {
  readonly maxBytes: number;
  readonly maxTokens: number;
  readonly probeMax: number;
  readonly probeBudgetShare: number;
  readonly negativeTtlDays: number;
  readonly versionsKeep: number;
};

function bounded(raw: string | undefined, fallback: number, name: string, min: number, max: number, integer = true): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`${name} invalide : ${integer ? 'entier' : 'nombre'} entre ${min} et ${max} attendu.`);
  return n;
}

/** Variables `BRIEF_*` (14 § 2) : bornées ; une valeur hors bornes refuse le démarrage plutôt que d'élargir. */
export function briefConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BriefConfig {
  const d = BRIEF_DEFAULTS;
  return {
    maxBytes: bounded(env['BRIEF_MAX_BYTES'], d.maxBytes, 'BRIEF_MAX_BYTES', 1_000, 16_000),
    maxTokens: bounded(env['BRIEF_MAX_TOKENS'], d.maxTokens, 'BRIEF_MAX_TOKENS', 100, 4_000),
    probeMax: bounded(env['BRIEF_PROBE_MAX'], d.probeMax, 'BRIEF_PROBE_MAX', 0, 5),
    probeBudgetShare: bounded(env['BRIEF_PROBE_BUDGET_SHARE'], d.probeBudgetShare, 'BRIEF_PROBE_BUDGET_SHARE', 0, 0.25, false),
    negativeTtlDays: bounded(env['BRIEF_NEGATIVE_TTL_DAYS'], d.negativeTtlDays, 'BRIEF_NEGATIVE_TTL_DAYS', 1, 365),
    versionsKeep: bounded(env['BRIEF_VERSIONS_KEEP'], d.versionsKeep, 'BRIEF_VERSIONS_KEEP', 1, 50),
  };
}

export const DEFAULT_BRIEF_CONFIG: BriefConfig = {
  maxBytes: BRIEF_DEFAULTS.maxBytes,
  maxTokens: BRIEF_DEFAULTS.maxTokens,
  probeMax: BRIEF_DEFAULTS.probeMax,
  probeBudgetShare: BRIEF_DEFAULTS.probeBudgetShare,
  negativeTtlDays: BRIEF_DEFAULTS.negativeTtlDays,
  versionsKeep: BRIEF_DEFAULTS.versionsKeep,
};

/** Codes de rapport (`brief_report[].reason`, 19c § 9.3). */
export const BRIEF_REASONS = [
  'brief_used',
  'brief_verified_unused',
  'brief_probe_failed',
  'brief_stale',
  'brief_unverifiable',
  'brief_host_ignored',
  'brief_duplicate',
  'brief_invalid_item',
  'brief_over_budget',
  'brief_widening_ignored',
  'brief_breaker_open',
  'brief_subject_excluded',
] as const;
export type BriefReason = (typeof BRIEF_REASONS)[number];

/** Codes d'erreur d'entrée (19c § 9.3) : `400`, valeur fautive jamais renvoyée, rien n'est créé. */
export const BRIEF_ERROR_CODES = ['invalid_brief', 'brief_too_large', 'secret_in_brief'] as const;
export type BriefErrorCode = (typeof BRIEF_ERROR_CODES)[number];

/** État d'un indice, posé par le CODE (jamais lu dans le dossier). */
export const BRIEF_HINT_STATES = ['used', 'verified_unused', 'probe_failed', 'ignored', 'unverified'] as const;
export type BriefHintState = (typeof BRIEF_HINT_STATES)[number];
