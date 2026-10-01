// SPDX-License-Identifier: AGPL-3.0-only
// Alertes actionnables (08 § 5) : on notifie les transitions vers `erreur`, `action_requise` et `bloquee`, et un
// `warning` qui dure au-delà de D ; pas chaque run dégradé. Une seule alerte externe par API et par cause, agrégée sur
// une fenêtre. Sans I/O. Le texte est factuel, sans reproche, et ne propose jamais de changer de réseau (INV6, X4).
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

export type AlertLocale = 'en' | 'fr';

const TEXT: Record<AlertLocale, Record<AlertCause, { subject: string; body: string }>> = {
  en: {
    status_erreur: { subject: 'needs attention (error)', body: 'The API is in error. Existing data is kept; a new investigation is needed.' },
    status_action_requise: { subject: 'action required', body: 'The API waits for an action from you before it can run again.' },
    status_bloquee: {
      subject: 'blocked by the site',
      body: 'The site refuses automated access. Scrapyomama stopped on purpose: it does not retry on its own and does not change IP address after a refusal.',
    },
    warning_stale: { subject: 'warning for too long', body: 'The API is still in warning and no clean run has cleared it since the delay allowed.' },
    run_failed: { subject: 'scheduled run failed', body: 'A scheduled run failed. The status of the API follows the usual rules; nothing else was attempted.' },
  },
  fr: {
    status_erreur: { subject: 'demande de l\'attention (erreur)', body: 'L\'API est en erreur. Les données existantes sont conservées ; une nouvelle enquête est nécessaire.' },
    status_action_requise: { subject: 'action requise', body: 'L\'API attend une action de ta part avant de pouvoir tourner à nouveau.' },
    status_bloquee: {
      subject: 'bloquée par le site',
      body: 'Le site refuse l\'accès automatisé. Scrapyomama s\'est arrêté volontairement : aucune relance automatique, et l\'adresse IP ne change pas après un refus.',
    },
    warning_stale: { subject: 'en avertissement depuis trop longtemps', body: 'L\'API reste en avertissement et aucun run propre ne l\'a levé dans le délai prévu.' },
    run_failed: { subject: 'run planifié en échec', body: 'Un run planifié a échoué. Le statut de l\'API suit les règles habituelles ; rien d\'autre n\'a été tenté.' },
  },
};

/** Texte brut de l'e-mail : API, cause, run, classe d'échec, lien console. Jamais d'item, de secret ni de contenu de page. */
export function renderAlertEmail(digest: AlertDigest, locale: AlertLocale = 'en'): { subject: string; text: string } {
  const t = TEXT[locale][digest.cause];
  const lines = [t.body, ''];
  const label = locale === 'fr' ? { api: 'API', run: 'Run', cls: 'Classe d\'échec', link: 'Console', n: 'Transitions', since: 'En avertissement depuis' } : { api: 'API', run: 'Run', cls: 'Failure class', link: 'Console', n: 'Transitions', since: 'In warning since' };
  lines.push(`${label.api} : ${digest.api}`);
  if (digest.run_id) lines.push(`${label.run} : ${digest.run_id}`);
  if (digest.failure_class) lines.push(`${label.cls} : ${digest.failure_class}`);
  if (digest.warning_since) lines.push(`${label.since} : ${digest.warning_since}`);
  if (digest.transitions.length > 0) {
    lines.push(`${label.n} : ${digest.transitions.length}`);
    for (const tr of digest.transitions) lines.push(`  ${tr.at}  ${tr.from ?? '-'} -> ${tr.to}${tr.reason ? ` (${tr.reason})` : ''}`);
  }
  if (digest.base_url) lines.push('', `${label.link} : ${digest.base_url.replace(/\/+$/, '')}/apis/${encodeURIComponent(digest.api)}`);
  return { subject: `[Scrapyomama] ${digest.api} : ${t.subject}`, text: lines.join('\n') + '\n' };
}
