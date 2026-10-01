// SPDX-License-Identifier: AGPL-3.0-only
// Alertes actionnables (08 § 5) : on notifie les transitions vers `erreur`, `action_requise` et `bloquee`, et un
// `warning` qui dure au-delà de D ; pas chaque run dégradé. Une seule alerte externe par API et par cause, agrégée sur
// une fenêtre. Sans I/O. Le texte est factuel, sans reproche, et ne propose jamais de changer de réseau (INV6, X4).
import { defaultI18n, renderAlertEmailLocalized } from '@runtime/i18n';
import type { ApiStatus } from '../model/enums.js';

export const ALERT_TARGET_STATUSES = ['erreur', 'action_requise', 'bloquee'] as const satisfies readonly ApiStatus[];
export type AlertTargetStatus = (typeof ALERT_TARGET_STATUSES)[number];

/** `run_failed` : échec d'un run planifié dont la planification demande `alert_on: [error]`. */
export type AlertCause = `status_${AlertTargetStatus}` | 'warning_stale' | 'run_failed';

/** Fenêtre de regroupement par défaut (s) ; configurable (`settings.alerts.window_seconds`). */
export const DEFAULT_ALERT_WINDOW_SECONDS = 300;

/** Cause d'alerte d'une transition, `null` si la transition n'est pas actionnable (sain, warning, enquête, réparation). */
export function alertCauseForTransition(to: ApiStatus): AlertCause | null {
  return (ALERT_TARGET_STATUSES as readonly string[]).includes(to) ? (`status_${to}` as AlertCause) : null;
}

/** Clé de regroupement : une alerte externe par API et par cause. */
export function alertGroupKey(apiId: string, cause: AlertCause): string {
  return `alert:${apiId}:${cause}`;
}

export type AlertDigest = {
  api: string;
  api_id: string;
  cause: AlertCause;
  /** Transitions agrégées sur la fenêtre, de la plus ancienne à la plus récente. */
  transitions: { from: ApiStatus | null; to: ApiStatus; reason: string | null; at: string }[];
  run_id?: string | null;
  failure_class?: string | null;
  /** Base de l'URL de la console (réglage de l'instance) ; sans elle, le lien est omis. */
  base_url?: string | null;
  warning_since?: string | null;
};

/** Langue d'un e-mail d'alerte : un code du registre des langues (`@runtime/i18n`) ; une langue inconnue retombe sur `en`. */
export type AlertLocale = string;

/**
 * E-mail de l'alerte (texte brut et HTML minimal avec `lang`) : API, cause, run, classe d'échec, lien console. Jamais d'item,
 * de secret ni de contenu de page. Textes du catalogue `email.alert.*` (tâche 3.20) ; heures en UTC étiqueté (les destinataires
 * sont des adresses configurées par l'admin, pas des comptes).
 */
export function renderAlertEmail(digest: AlertDigest, locale: AlertLocale = 'en'): { subject: string; text: string; html: string; lang: string } {
  const { renderer, supported } = defaultI18n();
  const lang = supported.includes(locale) ? locale : 'en';
  return renderAlertEmailLocalized(
    renderer,
    {
      api: digest.api,
      cause: digest.cause,
      runId: digest.run_id ?? null,
      failureClass: digest.failure_class ?? null,
      warningSince: digest.warning_since ? new Date(digest.warning_since) : null,
      transitions: digest.transitions.map((t) => ({ at: new Date(t.at), from: t.from, to: t.to, reason: t.reason })),
      consoleUrl: digest.base_url ?? null,
    },
    lang,
  );
}
