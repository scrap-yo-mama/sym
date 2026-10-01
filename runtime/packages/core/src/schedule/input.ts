// SPDX-License-Identifier: AGPL-3.0-only
// Variables datées de l'entrée d'une planification (08 § 5) : `{{today}}` et `{{yesterday}}`, dans le fuseau de la
// planification, au format `YYYY-MM-DD`. Vocabulaire fermé : toute autre accolade reste telle quelle (aucune évaluation).
import { localParts } from './rules.js';

const VARIABLE = /\{\{\s*(today|yesterday)\s*\}\}/g;

function shiftDay(date: string, days: number): string {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function scheduleDates(at: Date, timezone: string): { today: string; yesterday: string } {
  const today = localParts(at, timezone).date;
  return { today, yesterday: shiftDay(today, -1) };
}

/** Copie profonde de `input` où chaque chaîne voit ses variables datées remplacées. */
export function resolveScheduleInput(input: unknown, at: Date, timezone: string): unknown {
  const dates = scheduleDates(at, timezone);
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(VARIABLE, (_m, name: 'today' | 'yesterday') => dates[name]);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(input);
}
