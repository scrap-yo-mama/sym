// SPDX-License-Identifier: AGPL-3.0-only
// Mise en forme des nombres, octets, durées et dates selon la langue de la console (Intl, aucune dépendance).
const UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

export function formatBytes(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (Math.abs(value) >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return new Intl.NumberFormat(locale, { style: 'unit', unit: UNITS[unit], unitDisplay: 'short', maximumFractionDigits: unit === 0 ? 0 : 1 }).format(value);
}

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** Durée en secondes → « 1 h 02 min », « 4 min 05 s », « 12 s ». */
export function formatDuration(seconds: number, locale: string): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const unit = (n: number, u: 'hour' | 'minute' | 'second') => new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'narrow' }).format(n);
  if (h > 0) return `${unit(h, 'hour')} ${unit(m, 'minute')}`;
  if (m > 0) return `${unit(m, 'minute')} ${unit(r, 'second')}`;
  return unit(r, 'second');
}

export function formatDate(iso: string | null | undefined, locale: string): string {
  if (!iso) return '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(iso)) + ' UTC';
}

export function formatDay(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

/** Date relative courte (« il y a 3 s », « 3 seconds ago »). */
export function formatRelative(iso: string, locale: string, now = Date.now()): string {
  const diff = Math.round((Date.parse(iso) - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(diff, 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), 'hour');
  return rtf.format(Math.round(diff / 86_400), 'day');
}

/** Durée d'une session : de son départ à sa fin (ou maintenant). */
export function sessionSeconds(session: { startedAt?: string; endedAt?: string; usage?: { seconds: number } }, now = Date.now()): number {
  if (session.usage && session.endedAt) return session.usage.seconds;
  if (!session.startedAt) return 0;
  return ((session.endedAt ? Date.parse(session.endedAt) : now) - Date.parse(session.startedAt)) / 1000;
}
