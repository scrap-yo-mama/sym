// SPDX-License-Identifier: AGPL-3.0-only
// Pseudo-locale `qps-ploc` (21 § 9) : générée en mémoire depuis `en.json`, jamais livrée ni versionnée. Accents, crochets
// `⟦ ⟧`, variables intactes ; extension selon la longueur de la source (table W3C reprise par U6). Tout texte visible sans
// `⟦` est une chaîne en dur ou une donnée (`assert_no_hardcoded_strings_pseudo`, tâche 3.6).
import type { CatalogTree } from './catalog.js';

/** Étiquette de la pseudo-locale (à valider, 21 § 10). */
export const PSEUDO_LOCALE = 'qps-ploc';
export const PSEUDO_OPEN = '⟦';
export const PSEUDO_CLOSE = '⟧';

const ACCENTS: Readonly<Record<string, string>> = {
  a: 'à', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'À', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/** Facteur d'expansion selon la longueur de la source (table W3C : ≤ 10 ×3, 11-20 ×2, 21-30 ×1,8, 31-50 ×1,6, 51-70 ×1,4, > 70 ×1,3). */
export function expansionFactor(length: number): number {
  if (length <= 10) return 3;
  if (length <= 20) return 2;
  if (length <= 30) return 1.8;
  if (length <= 50) return 1.6;
  if (length <= 70) return 1.4;
  return 1.3;
}

/** Parties d'un message qui ne doivent jamais être accentuées : variables `{x}`, littéraux `{'…'}`, liens `@:clé`, séparateur de pluriel. */
const PROTECTED = /(\{[^{}]*\}|@(?:\.\w+)?:[\w.]+| \| )/g;

/** Pseudo-localise un message : accents, crochets, rallonge (mots de remplissage, pour que le texte puisse se replier). */
export function pseudoLocalize(message: string): string {
  const forms = message.split(' | ');
  return forms.map(pseudoForm).join(' | ');
}

function pseudoForm(form: string): string {
  const parts = form.split(PROTECTED);
  const accented = parts.map((part, index) => (index % 2 === 1 ? part : [...part].map((ch) => ACCENTS[ch] ?? ch).join(''))).join('');
  const visible = form.replace(PROTECTED, '').length;
  const extra = Math.max(0, Math.round(visible * (expansionFactor(visible) - 1)));
  const filler = extra > 0 ? ` ${'·'.repeat(Math.min(extra, 5))}${extra > 5 ? ` ${'·'.repeat(Math.min(extra - 5, 5))}` : ''}${extra > 10 ? ` ${'·'.repeat(extra - 10)}` : ''}` : '';
  return `${PSEUDO_OPEN}${accented}${filler}${PSEUDO_CLOSE}`;
}

/** Catalogue pseudo-localisé (en mémoire) d'un catalogue source. `mcp.model.*` n'est jamais pseudo-localisé. */
export function pseudoCatalog(source: CatalogTree, skipPrefixes: readonly string[] = ['mcp.model'], prefix = ''): CatalogTree {
  const out: Record<string, string | CatalogTree> = {};
  for (const [key, value] of Object.entries(source)) {
    const path = prefix + key;
    if (typeof value === 'string') {
      out[key] = skipPrefixes.some((p) => path === p || path.startsWith(`${p}.`)) ? value : pseudoLocalize(value);
    } else if (skipPrefixes.some((p) => path === p)) {
      out[key] = value;
    } else {
      out[key] = pseudoCatalog(value, skipPrefixes, `${path}.`);
    }
  }
  return out;
}
