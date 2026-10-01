// SPDX-License-Identifier: AGPL-3.0-only
// Formats d'affichage (coûts, durées, dates), localisés par Intl via packages/i18n (tâche 3.20). Aucune logique métier : les montants viennent du serveur,
// jamais recalculés ici. Une estimation est toujours préfixée de « ~ » (06 § 2 : « préfixe ~ s'il est estimé »).

import { fmtDuration, fmtUsd } from '@runtime/i18n/browser';

// Fuseau d'affichage : `users.timezone` du compte connecté (21 § 5) ; absent, celui du navigateur.
let displayTimeZone: string | undefined;
export function setDisplayTimeZone(zone: string | null | undefined): void {
  displayTimeZone = zone ?? undefined;
}

/** Montant en dollars : « ~0,002 $ » (estimation) ou « 0,002 $ » (`fmtUsd` de packages/i18n, `narrowSymbol`). `null` : prix inconnu (jamais affiché comme 0, 08 § 1). */
export function formatUsd(value: number | null | undefined, locale: string, estimated = false): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const text = fmtUsd(value, locale);
  return estimated ? `~${text}` : text;
}

/** Durée courte, par `Intl` (`fmtDuration` de packages/i18n). */
export function formatDuration(ms: number | null | undefined, locale: string): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  return fmtDuration(ms, locale);
}

/** Date et heure locales, dans le fuseau du compte ; une date illisible renvoie null. */
export function formatDateTime(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', ...(displayTimeZone === undefined ? {} : { timeZone: displayTimeZone }) }).format(date);
}
