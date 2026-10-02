// SPDX-License-Identifier: AGPL-3.0-only
// Normalisation et listes de mots de la vitrine (20 §2.2, 22b §1) : un seul régime de lexique pour toutes les surfaces.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vitrineDir } from './paths.ts';

/** Casse, accents, apostrophes typographiques, traits d'union et espaces (insécables compris) : « passe partout » = « passe-partout ». */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u2010-\u2015-]/g, ' ')
    .replace(/[\s\u00a0\u202f]+/g, ' ')
    .trim();
}

/**
 * Entrées d'une liste (une par ligne, `#` = commentaire), normalisées. `racine-` devient `racine*` (préfixe de mot) ;
 * `-racine-` devient `*racine*` (n'importe où dans un mot : `-captcha-` prend reCAPTCHA, hCaptcha, 2Captcha).
 */
export function parseList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => `${line.startsWith('-') ? '*' : ''}${normalize(line)}${line.endsWith('-') ? '*' : ''}`);
}

export function loadList(name: string): string[] {
  return parseList(readFileSync(join(vitrineDir, 'lexicon', name), 'utf8'));
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Expression d'une entrée : `racine*` (racine- du fichier) = préfixe de mot ; `*racine*` (-racine- du fichier) = n'importe
 * où dans un mot, chiffres compris ; sinon mot ou expression entière (pluriel admis).
 */
function entryPattern(entry: string): RegExp {
  const infix = entry.startsWith('*');
  const prefix = entry.endsWith('*');
  const body = escape(entry.slice(infix ? 1 : 0, prefix ? -1 : undefined));
  return new RegExp(`${infix ? '' : '(?<![a-z0-9])'}${body}${prefix ? '[a-z0-9]*' : 's?(?![a-z0-9])'}`, 'u');
}

/** Entrées de `list` présentes dans `text` (après normalisation). */
export function findEntries(text: string, list: readonly string[]): string[] {
  const haystack = normalize(text);
  return list.filter((entry) => entryPattern(entry).test(haystack));
}

/** Retire de `text` les phrases (normalisées) de `allowed` : liste blanche des phrases inscrites au registre. */
export function stripPhrases(text: string, allowed: readonly string[]): string {
  let out = normalize(text);
  for (const phrase of allowed) out = out.split(normalize(phrase)).join(' ');
  return out;
}
