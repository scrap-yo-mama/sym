// SPDX-License-Identifier: AGPL-3.0-only
// U0.3 (3.19, partie 1) : le guide de voix `voice.md` existe à côté des catalogues, cite les 7 situations de
// cdc/scrapyomama-ux/08-specs-voix.md § 3, les règles de micro-texte, le glossaire et 20 paires fr/en, et n'emploie aucun mot
// des listes `forbidden.<langue>.txt` (assert_forbidden_words_per_locale).
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { DEFAULT_LOCALES_DIR } from './node.js';

const VOICE = new URL('../voice.md', import.meta.url);
const text = existsSync(VOICE) ? readFileSync(VOICE, 'utf8') : '';

const SITUATIONS = ['Prise en charge', 'Progression', 'Question', 'Succès', 'Échec avec action', 'Site qui refuse', 'Attente longue'];

function section(title: string): string {
  const start = text.indexOf(`## ${title}`);
  if (start < 0) return '';
  const next = text.indexOf('\n## ', start + 3);
  return text.slice(start, next < 0 ? undefined : next);
}

describe('voice.md : guide de voix SYM 👻 (U0.3)', () => {
  test('le guide existe, avec la DA, la signature, le ton par situation, les règles, le glossaire et les paires', () => {
    expect(existsSync(VOICE)).toBe(true);
    for (const title of ['La DA en une ligne', 'La signature', 'Ton par situation', 'Règles de micro-texte', 'Glossaire', 'Paires fr/en de référence']) {
      expect(section(title), title).not.toBe('');
    }
  });

  test('cite les 7 situations de 08 § 3, chacune avec son exemple fr et en', () => {
    const tone = section('Ton par situation');
    for (const situation of SITUATIONS) expect(tone, situation).toContain(`**${situation}**`);
    expect(tone.split('\n').filter((l) => l.startsWith('| **')).length).toBe(7);
  });

  test('20 paires fr/en au moins, numérotées, deux cellules non vides', () => {
    const rows = section('Paires fr/en de référence').split('\n').filter((l) => /^\| \d+ \|/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(20);
    for (const row of rows) {
      const cells = row.split('|').slice(1, -1).map((c) => c.trim());
      expect(cells.length, row).toBe(4); // numéro, situation, fr, en
      expect(cells[2]!.length, row).toBeGreaterThan(0);
      expect(cells[3]!.length, row).toBeGreaterThan(0);
    }
  });

  test('règles : les 8 règles de 08 § 4 y sont ; le glossaire garde SYM, run, MCP, API, slug', () => {
    expect(section('Règles de micro-texte').split('\n').filter((l) => /^\| \*\*/.test(l)).length).toBeGreaterThanOrEqual(8);
    const glossary = section('Glossaire');
    for (const term of ['SYM', 'run', 'MCP', 'API', 'slug']) expect(glossary, term).toContain(`**${term}**`);
  });

  test('assert_forbidden_words_per_locale : aucun mot de forbidden.fr.txt ni de forbidden.en.txt dans le guide', () => {
    const lower = text.toLowerCase();
    for (const code of ['fr', 'en']) {
      const words = readFileSync(`${DEFAULT_LOCALES_DIR}/forbidden.${code}.txt`, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l !== '' && !l.startsWith('#'));
      expect(words.length).toBeGreaterThan(0);
      for (const word of words) expect(lower, `${code} : « ${word} »`).not.toContain(word);
    }
  });

  test('aucune section de promesses négatives (DA grey) : le guide dit ce que SYM fait', () => {
    expect(text).not.toMatch(/^#+ .*(ne fera jamais|never)/im);
  });
});
