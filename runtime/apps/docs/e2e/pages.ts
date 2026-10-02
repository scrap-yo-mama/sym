// SPDX-License-Identifier: AGPL-3.0-only
// Pages de la landing jouées par les tests E2E : accueil et pages juridiques, en anglais (`/`) et en français (`/fr/`).
import { readFileSync } from 'node:fs';
import { HOME_PATHS, LEGAL_PATHS } from '../src/landing/href.ts';
import type { Lang } from '../src/landing/types.ts';

export const preprodUrl = (): string => {
  const url = process.env['LANDING_PREPROD_URL'];
  if (!url) throw new Error('LANDING_PREPROD_URL absent : la préproduction est démarrée par global-setup.ts');
  return url;
};

export const homeUrl = (lang: Lang): string => `${preprodUrl()}/${HOME_PATHS[lang]}`;
export const LANGS_UNDER_TEST: Lang[] = ['en', 'fr'];
const legalUrls = (): string[] => LANGS_UNDER_TEST.flatMap((lang) => [LEGAL_PATHS[lang].privacy, LEGAL_PATHS[lang].notice].map((path) => `${preprodUrl()}/${path}`));
export const allLandingUrls = (): string[] => [...LANGS_UNDER_TEST.map(homeUrl), ...legalUrls()];

export type Budgets = {
  firstViewKB: number;
  jsGzipKB: number;
  fontsKB: number;
  requests: number;
  thirdPartyRequests: number;
  lcpMs: number;
  cls: number;
  titleChars: number;
  descriptionChars: number;
  /** Bridage du laboratoire (profil mobile de Lighthouse) : aller-retour réseau, débits, ralentissement du processeur. */
  lab: { rttMs: number; downloadKbps: number; uploadKbps: number; cpuSlowdown: number };
  /** Scores Lighthouse mobile minimaux, sur 100. */
  lighthouse: Record<string, number>;
};
export const budgets = (): Budgets => (JSON.parse(readFileSync(new URL('../../../scripts/vitrine/budgets.json', import.meta.url), 'utf8')) as { landing: Budgets }).landing;
