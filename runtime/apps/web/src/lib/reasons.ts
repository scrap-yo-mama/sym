// SPDX-License-Identifier: AGPL-3.0-only
// Codes de raison (06 § 4.2) : l'API renvoie des codes stables avec leurs paramètres, jamais des phrases ; la console
// les traduit (`reasons.<code>` dans `en.json` et `fr.json`). Un code ajouté exige sa ligne dans les deux langues
// (parité testée, `assert_reason_codes_stable`).
import type { components } from '@runtime/client';
import { formatDateTime } from '@/lib/display-format';
import type { ApiStatus } from '@/lib/status';

export type ReasonMessage = components['schemas']['ReasonMessage'];

/** Codes de la table de 06 § 4.2 (le drapeau `stale` compris), dans l'ordre de la table. */
export const SPEC_REASON_CODES = [
  'retried',
  'escalated',
  'repaired',
  'optional_fields_missing',
  'volume_anomaly',
  'pagination_short',
  'slow',
  'cost_anomaly',
  'stale',
  'unavailable',
  'reverted',
  'reinvestigation_failed',
  'rate_limited',
  'geo_restriction',
  'blocked_by_protection',
  'forbidden',
  'robots_disallowed',
  'robots_unreachable',
  'payment_required',
  'auth_required',
  'cookie_expired',
  'session_device_bound',
  'challenge_in_tunnel',
  'secret_unreadable',
  'account_limit',
  'session_owner_required',
  'llm_refused',
] as const;

/**
 * Codes qui complètent la table pour les écrans de cette tâche : la raison d'un statut sans code dans 06 § 4.2
 * (enquête, réparation, état sain), les causes d'« Action requise » sans code nommé (proxy requis, tunnel hors ligne)
 * et `not_found` (04 § 7). Le serveur (3.1) produit les mêmes noms.
 */
export const EXTRA_REASON_CODES = ['investigating', 'healthy', 'repairing', 'repair_exhausted', 'proxy_not_configured', 'tunnel_offline', 'not_found'] as const;

/**
 * Codes de la reprise par étape et de l'agent instruit (19b § 3, tâche 2.13), ajoutés à la table de 06 § 4.2 par 19b
 * (mêmes règles de parité et de test de chaîne), dans l'ordre de 19b.
 */
export const STEP_REASON_CODES = ['repair_not_validated', 'write_step_broken', 'step_cascade', 'not_compilable', 'session_step_broken'] as const;
export type StepReasonCode = (typeof STEP_REASON_CODES)[number];

export const REASON_CODES: readonly string[] = [...SPEC_REASON_CODES, ...EXTRA_REASON_CODES, ...STEP_REASON_CODES];

/**
 * Action proposée par un code de 19b § 3 (`reasonAction.<code>`) et l'onglet de la fiche qui la porte. « Ouvrir le
 * brouillon » mène à l'onglet Stratégie (les brouillons y vivront avec 3.14) ; « Voir le mode agent instruit » à la section
 * de la vue d'ensemble, jamais à une activation directe ; « Ré-enquêter » est le bouton de l'en-tête (aucun lien en plus).
 */
export const STEP_REASON_ACTIONS: Record<StepReasonCode, { tab: 'runs' | 'strategy' | 'overview'; hash?: string } | 'reinvestigate'> = {
  repair_not_validated: { tab: 'runs' },
  write_step_broken: { tab: 'strategy' },
  step_cascade: 'reinvestigate',
  not_compilable: { tab: 'overview', hash: '#instructed' },
  session_step_broken: { tab: 'strategy' },
};

export function isStepReasonCode(code: string | null | undefined): code is StepReasonCode {
  return (STEP_REASON_CODES as readonly string[]).includes(code ?? '');
}

/** Codes de phrase de diff (`StrategyDiff.summary`, 06 § 2 niveau 1), traduits par `diffSummary.<code>`. */
export const DIFF_SUMMARY_CODES = ['selector_changed', 'pagination_changed', 'execution_changed', 'network_changed', 'fields_changed', 'script_changed', 'no_change'] as const;

const DATE_PARAMS = new Set(['date', 'at']);

/**
 * Paramètres prêts pour l'interpolation : nombres et dates mis en forme selon la langue, autres valeurs telles quelles.
 * Les noms de paramètres sont ceux du serveur (`n`, `m`, `p`, `x`, `a`, `b`, `date`, `domain`, `name`, `offer`…).
 */
export function reasonParams(params: ReasonMessage['params'] | undefined, locale: string): Record<string, string> {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'number') out[key] = number.format(value);
    else out[key] = DATE_PARAMS.has(key) && !Number.isNaN(Date.parse(value)) ? formatDateTime(value, locale) : value;
  }
  return out;
}

/** Clé i18n d'un code de raison ; le texte générique du statut sert quand le code est inconnu ou absent. */
function reasonKey(code: string): string {
  return `reasons.${code}`;
}

function statusDefaultKey(status: ApiStatus): string {
  return `statusDefault.${status}`;
}

type Translate = (key: string, named?: Record<string, string>) => string;
type Exists = (key: string) => boolean;

/** Paramètres qui portent un code d'exécution ou de réseau (« fetch_in_page », « tunnel »…) : traduits quand le code est connu. */
function withTranslatedCodes(t: Translate, te: Exists, params: Record<string, string>): Record<string, string> {
  const out = { ...params };
  for (const [key, scopes] of [['execution', ['execution']], ['network', ['network']], ['from', ['execution', 'network']], ['to', ['execution', 'network']]] as const) {
    const value = out[key];
    if (value === undefined) continue;
    const scope = scopes.find((candidate) => te(`${candidate}.${value}`));
    if (scope) out[key] = t(`${scope}.${value}`);
  }
  return out;
}

/**
 * Texte visible de la raison d'un statut. Code inconnu ou absent : phrase générique du statut. Une raison ne contient
 * jamais de HTML : le résultat est inséré comme texte.
 */
export function describeReason(t: Translate, te: Exists, locale: string, status: ApiStatus, reason: ReasonMessage | null | undefined): string {
  if (reason && te(reasonKey(reason.code))) return t(reasonKey(reason.code), withTranslatedCodes(t, te, reasonParams(reason.params, locale)));
  return t(statusDefaultKey(status));
}

/** Phrase du diff (niveau 1) : `diffSummary.<code>` ou, sans traduction, la phrase générique avec le nombre de champs. */
export function describeDiffSummary(t: Translate, te: Exists, locale: string, summary: ReasonMessage, fieldCount: number): string {
  const key = `diffSummary.${summary.code}`;
  if (te(key)) return t(key, withTranslatedCodes(t, te, reasonParams(summary.params, locale)));
  return t('diffSummary.generic', { n: String(fieldCount) });
}

/** Libellé court d'une classe d'échec (`failure_class`, 04b § 1) : `failureClass.<code>`, famille `llm_*` à part, sinon le code. */
export function describeFailureClass(t: Translate, te: Exists, code: string): string {
  if (te(`failureClass.${code}`)) return t(`failureClass.${code}`);
  return code.startsWith('llm_') ? t('failureClass.llm', { code }) : code;
}

/** Libellé court d'un code de raison sans paramètres (listes de runs : le run ne porte que les codes). */
export function describeReasonCode(t: Translate, te: Exists, code: string): string {
  return te(`reasonLabel.${code}`) ? t(`reasonLabel.${code}`) : code;
}
