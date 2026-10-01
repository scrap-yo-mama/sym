// SPDX-License-Identifier: AGPL-3.0-only
// Formats d'affichage (montants, dates, durées, pourcentages). Aucune règle métier : seulement de la présentation,
// selon la langue active (`en` ou `fr`).

/** Montant en dollars : « ~0,002 $ » (préfixe « ~ » quand il est estimé), « — » quand le prix est inconnu (jamais 0). */
export function formatUsd(value: number | null | undefined, locale: string, estimated = false): string {
  if (value === null || value === undefined) return '—';
  const digits = value === 0 || value >= 1 ? 2 : 4;
  const text = new Intl.NumberFormat(locale, { minimumFractionDigits: value === 0 ? 2 : 0, maximumFractionDigits: digits }).format(value);
  return `${estimated ? '~' : ''}${text} $`;
}

export function formatPercent(value: number | null | undefined, locale: string): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value);
}

export function formatDateTime(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function formatDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** « il y a 2 h » : la plus grande unité entière ; « maintenant » sous la minute. */
export function formatAgo(iso: string | null | undefined, locale: string, now: number = Date.now()): string {
  if (!iso) return '—';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '—';
  const delta = time - now;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  for (const [unit, size] of UNITS) {
    if (Math.abs(delta) >= size) return formatter.format(Math.trunc(delta / size), unit);
  }
  return formatter.format(0, 'minute');
}

export function formatDuration(ms: number | null | undefined, locale: string): string {
  if (ms === null || ms === undefined) return '—';
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  if (ms < 1_000) return `${number.format(ms)} ms`;
  if (ms < 60_000) return `${number.format(ms / 1_000)} s`;
  return `${number.format(ms / 60_000)} min`;
}
