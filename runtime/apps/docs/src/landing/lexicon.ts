// SPDX-License-Identifier: AGPL-3.0-only
// Régime de lexique de la landing (22b § 1, 20 § 2.2) : listes P (promesses) et L (termes de limite) par langue, marques de tiers
// et exceptions descriptives. Même normalisation partout : casse, accents, traits d'union, espaces (insécables comprises).
// Outil de test et de contrôle : lu par les tests assert_landing_no_bypass_copy et assert_landing_no_third_party_brand.
import { readFileSync } from 'node:fs';
import type { Lang } from './types.ts';

const dir = new URL('../../landing/lexicon/', import.meta.url);

export type Lexicon = { promises: string[]; limits: string[] };

/** Casse, accents, traits d'union et espaces repliés : « Passe-partout » = « passe partout ». */
export function normalizeForLexicon(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[‐-―\-_]+/g, ' ')
    .replace(/[\s\u00a0\u202f]+/g, ' ')
    .trim();
}

function readTerms(file: string): { promises: string[]; limits: string[] } {
  const lexicon: Lexicon = { promises: [], limits: [] };
  let list: keyof Lexicon | undefined;
  for (const raw of readFileSync(new URL(file, dir), 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line === '[P]') list = 'promises';
    else if (line === '[L]') list = 'limits';
    else if (list) lexicon[list].push(line);
  }
  return lexicon;
}

/** Union des listes de toutes les langues livrées : appliquée à toute surface, quelle que soit sa langue. */
export function loadLexicon(langs: readonly Lang[] = ['fr', 'en']): Lexicon {
  const union: Lexicon = { promises: [], limits: [] };
  for (const lang of langs) {
    const own = readTerms(`forbidden.${lang}.txt`);
    union.promises.push(...own.promises);
    union.limits.push(...own.limits);
  }
  return { promises: [...new Set(union.promises)], limits: [...new Set(union.limits)] };
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Occurrences des termes dans un texte : une racine (`contourn-`) est un préfixe, un autre terme un mot entier (pluriel en « s » admis). */
export function findTerms(text: string, terms: readonly string[]): string[] {
  const haystack = normalizeForLexicon(text);
  const found: string[] = [];
  for (const term of terms) {
    const stem = term.endsWith('-');
    const needle = escape(normalizeForLexicon(stem ? term.slice(0, -1) : term));
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${needle}${stem ? '' : '(?:s)?(?![\\p{L}\\p{N}])'}`, 'u');
    if (pattern.test(haystack)) found.push(term);
  }
  return found;
}

function loadList(file: string): string[] {
  return readFileSync(new URL(file, dir), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export const loadBrands = (): string[] => loadList('brands.txt');
export const loadBrandExceptions = (): string[] => loadList('exceptions.txt');
