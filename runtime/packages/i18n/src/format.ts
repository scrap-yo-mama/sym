// SPDX-License-Identifier: AGPL-3.0-only
// Formats (21 § 5, `packages/i18n/src/format.ts`) : tout nombre, coût, date, durée ou liste passe par ici, avec la langue
// résolue, côté serveur comme côté console. Les tests comparent à la sortie d'`Intl` calculée, jamais à une chaîne copiée.

function safeLocale(locale: string): string {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

/**
 * Coût en dollars américains, `currencyDisplay: 'narrowSymbol'` (« 0,50 $ », jamais « 0,50 $US »). Deux décimales au moins ; en
 * dessous de 1 $, jusqu'à 4 quand elles servent (« 0,0021 $ », « 0,0123 $ ») : un coût par run reste lisible. Aucune conversion de
 * devise (taux externe = sortie non décidée, INV9).
 */
export function fmtUsd(amount: number, locale: string): string {
  const small = Math.abs(amount) < 1;
  return new Intl.NumberFormat(safeLocale(locale), {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits: small ? 4 : 2,
  }).format(amount);
}

export function fmtNumber(value: number, locale: string, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(safeLocale(locale), options).format(value);
}

export function fmtPercent(ratio: number, locale: string): string {
  return new Intl.NumberFormat(safeLocale(locale), { style: 'percent', maximumFractionDigits: 0 }).format(ratio);
}

/** Taille en octets, `style: 'unit'` (« ko / Mo » en `fr`, « kB / MB » en `en`). */
export function fmtBytes(bytes: number, locale: string): string {
  const units = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;
  let value = Math.max(0, bytes);
  let index = 0;
  while (value >= 1000 && index < units.length - 1) {
    value /= 1000;
    index += 1;
  }
  return new Intl.NumberFormat(safeLocale(locale), { style: 'unit', unit: units[index] ?? 'byte', unitDisplay: 'short', maximumFractionDigits: index === 0 ? 0 : 1 }).format(value);
}

type DurationFormatCtor = new (locale: string, options: { style: 'short' | 'narrow' | 'long' }) => { format(duration: Record<string, number>): string };

/** Durée courte (« 1,2 s », « 1 min 12 s ») : `NumberFormat` en unités sous la minute, `Intl.DurationFormat` s'il existe au-delà, sinon `NumberFormat` en unités. */
export function fmtDuration(ms: number, locale: string): string {
  const tag = safeLocale(locale);
  const total = Math.max(0, Math.round(ms));
  if (total < 1000) return new Intl.NumberFormat(tag, { style: 'unit', unit: 'millisecond', unitDisplay: 'short' }).format(total);
  // Moins d'une minute : secondes avec une décimale (« 1,2 s »), que `DurationFormat` arrondirait à la seconde.
  if (total < 60_000) return new Intl.NumberFormat(tag, { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 1 }).format(total / 1000);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.round((total % 60_000) / 1000);
  const carry = seconds === 60 ? 1 : 0;
  const parts: Record<string, number> = {};
  if (hours > 0) parts.hours = hours;
  if (minutes + carry > 0) parts.minutes = minutes + carry;
  if (seconds - carry * 60 > 0 || Object.keys(parts).length === 0) parts.seconds = seconds - carry * 60;
  const DurationFormat = (Intl as unknown as { DurationFormat?: DurationFormatCtor }).DurationFormat;
  if (DurationFormat) return new DurationFormat(tag, { style: 'short' }).format(parts);
  const units: Record<string, string> = { hours: 'hour', minutes: 'minute', seconds: 'second' };
  const formatter = (unit: string) => new Intl.NumberFormat(tag, { style: 'unit', unit, unitDisplay: 'short' });
  return Object.entries(parts)
    .map(([key, value]) => formatter(units[key] ?? 'second').format(value))
    .join(' ');
}

/**
 * Date et heure. Avec `timeZone` (IANA, `users.timezone`) l'heure porte ce fuseau ; sans fuseau, UTC étiqueté (« UTC »),
 * jamais une heure locale du serveur (21 § 5, 21b M11). Un fuseau invalide retombe sur UTC étiqueté.
 */
export function fmtDate(d: Date, locale: string, timeZone?: string | null): string {
  const tag = safeLocale(locale);
  const base: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' };
  if (timeZone) {
    try {
      return new Intl.DateTimeFormat(tag, { ...base, timeZone }).format(d);
    } catch {
      // fuseau inconnu : UTC étiqueté
    }
  }
  return new Intl.DateTimeFormat(tag, { ...base, timeZone: 'UTC' }).format(d);
}

const RELATIVE_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

/** « il y a 2 h », « maintenant » sous la minute (`numeric: 'auto'`). */
export function fmtRelative(d: Date, locale: string, now: Date = new Date()): string {
  const delta = d.getTime() - now.getTime();
  const formatter = new Intl.RelativeTimeFormat(safeLocale(locale), { numeric: 'auto', style: 'short' });
  for (const [unit, size] of RELATIVE_UNITS) {
    if (Math.abs(delta) >= size) return formatter.format(Math.trunc(delta / size), unit);
  }
  return formatter.format(0, 'minute');
}

/** Liste (« a, b et c ») par `ListFormat`, jamais `join(', ')`. */
export function fmtList(items: readonly string[], locale: string): string {
  return new Intl.ListFormat(safeLocale(locale), { style: 'long', type: 'conjunction' }).format(items);
}

/** Comparateur de tri et de filtre : `numeric` et insensible à la casse et aux accents. */
export function collator(locale: string): Intl.Collator {
  return new Intl.Collator(safeLocale(locale), { numeric: true, sensitivity: 'base' });
}

/** Fuseau IANA valide (contrôlé contre `Intl.supportedValuesOf('timeZone')`, plus `UTC`). */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  if (value === 'UTC') return true;
  return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone').includes(value);
}
