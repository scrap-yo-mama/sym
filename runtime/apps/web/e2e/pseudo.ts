// SPDX-License-Identifier: AGPL-3.0-only
// Pseudo-locale de la console (projet Playwright `ui-pseudo`, part de 3.6 confiée à 3.17 : Catalogue et Nouvelle API). Chaque
// chaîne du catalogue anglais est accentuée, allongée d'environ 40 % et encadrée de ⟦ ⟧ : un texte resté en clair à l'écran est
// une chaîne codée en dur (`assert_no_hardcoded_strings_pseudo`), un texte coupé ou qui déborde est une mise en page qui ne tient
// pas la traduction (`assert_no_text_overflow_pseudo`). La syntaxe de vue-i18n est gardée telle quelle : paramètres `{n}`,
// formes plurielles séparées par `|`, liens `@:clé`. Aucune dépendance : la table d'accents est ici.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';

const ACCENTS: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ď', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ĺ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: 'ʠ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ď', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ĺ', M: 'Ṁ', N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/** Marques de début et de fin d'une chaîne pseudo-localisée. */
export const PSEUDO_OPEN = '⟦';
export const PSEUDO_CLOSE = '⟧';

/** Une forme (sans `|`) : lettres accentuées hors des paramètres `{…}` et des liens `@:…`, puis allongement et marques. */
function pseudoForm(form: string): string {
  const lead = /^\s*/.exec(form)?.[0] ?? '';
  const trail = /\s*$/.exec(form)?.[0] ?? '';
  const core = form.slice(lead.length, form.length - trail.length);
  if (core === '') return form;
  let out = '';
  let depth = 0;
  let letters = 0;
  for (let at = 0; at < core.length; at += 1) {
    const char = core[at] ?? '';
    if (char === '{') depth += 1;
    if (depth === 0 && char === '@' && core[at + 1] === ':') return form;
    if (depth === 0 && ACCENTS[char]) {
      out += ACCENTS[char];
      letters += 1;
    } else out += char;
    if (char === '}') depth = Math.max(0, depth - 1);
  }
  // Allongement d'environ 40 % (au moins deux caractères) : la marge que demandent les langues plus longues que l'anglais.
  const pad = '·'.repeat(Math.max(2, Math.round(letters * 0.4)));
  return `${lead}${PSEUDO_OPEN}${out} ${pad}${PSEUDO_CLOSE}${trail}`;
}

/** Message vue-i18n pseudo-localisé ; chaque forme plurielle l'est séparément. */
export function pseudoMessage(message: string): string {
  return message
    .split('|')
    .map((form) => pseudoForm(form))
    .join('|');
}

/** Catalogue entier, récursivement (les clés ne changent pas). */
export function pseudoMessages(node: unknown): unknown {
  if (typeof node === 'string') return pseudoMessage(node);
  if (Array.isArray(node)) return node.map(pseudoMessages);
  if (typeof node === 'object' && node !== null) return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, pseudoMessages(value)]));
  return node;
}

/**
 * Sert la pseudo-locale à la place du catalogue anglais : la console charge `en` (préférence posée par la fixture) et reçoit,
 * pour son module `assets/en-*.js`, un module dont l'export par défaut est le catalogue pseudo-localisé.
 */
export async function routePseudoLocale(page: Page): Promise<void> {
  const messages = JSON.parse(readFileSync(new URL('../src/i18n/locales/en.json', import.meta.url), 'utf8')) as unknown;
  const body = `export default ${JSON.stringify(pseudoMessages(messages))};\n`;
  await page.route(/\/assets\/en-[\w-]+\.js$/, (route) => route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body }));
}
