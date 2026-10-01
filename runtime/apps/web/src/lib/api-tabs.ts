// SPDX-License-Identifier: AGPL-3.0-only
// Onglets de la fiche d'une API (06 § 1, figure 1) et leur segment d'adresse : `/apis/:slug/:tab`.

export const API_TABS = ['overview', 'schemas', 'strategy', 'runs', 'status', 'schedules', 'access', 'investigations'] as const;
export type ApiTab = (typeof API_TABS)[number];

export function isApiTab(value: unknown): value is ApiTab {
  return typeof value === 'string' && (API_TABS as readonly string[]).includes(value);
}
