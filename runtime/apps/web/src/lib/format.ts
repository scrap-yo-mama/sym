// SPDX-License-Identifier: AGPL-3.0-only
// Formats d'affichage (coûts, durées, dates), localisés par Intl. Aucune logique métier : les montants viennent du serveur,
// jamais recalculés ici. Une estimation est toujours préfixée de « ~ » (06 § 2 : « préfixe ~ s'il est estimé »).

/** Montant en dollars : « ~0,002 $ » (estimation) ou « 0,002 $ ». `null` : prix inconnu (jamais affiché comme 0, 08 § 1). */
export function formatUsd(value: number | null | undefined, locale: string, estimated = false): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const text = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
  return estimated ? `~${text}` : text;
}

/** Durée courte : « 240 ms », « 1,2 s », « 2 min 5 s ». */
export function formatDuration(ms: number | null | undefined, locale: string): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

/** Date et heure locales ; une date illisible renvoie null. */
export function formatDateTime(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
