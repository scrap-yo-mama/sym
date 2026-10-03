// SPDX-License-Identifier: AGPL-3.0-only
// Intention d'une étape (19 §4) : issue d'un LLM qui a lu des pages, elle n'est JAMAIS une consigne. Elle arrive à l'agent
// d'étape comme un indice non fiable, dans `<untrusted_step_intent>`, nettoyée comme la mémoire du catalogue : caractères
// invisibles et de contrôle retirés, balises retirées, 200 caractères au plus. Les étapes instruites non confirmées
// (agent instruit) suivent la même règle.

export const STEP_INTENT_MAX = 200;
export const UNTRUSTED_STEP_INTENT_TAG = 'untrusted_step_intent';

/** Contrôles, formats invisibles et marques de direction (U+200B à U+200F, U+202A à U+202E, U+2060 à U+206F, BOM). */
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb],
];
const hex = (n: number): string => '\\u' + n.toString(16).padStart(4, '0');
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => (a === b ? hex(a) : `${hex(a)}-${hex(b)}`)).join('')}]`, 'g');

export function sanitizeStepIntent(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(/<[^>]{0,200}>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STEP_INTENT_MAX)
    .trim();
}

/** Bloc non fiable prêt pour un prompt ; son contenu ne peut ni fermer ni rouvrir la balise (aucun `<` ni `>`). */
export function untrustedStepIntent(raw: unknown): string {
  return `<${UNTRUSTED_STEP_INTENT_TAG}>${sanitizeStepIntent(raw)}</${UNTRUSTED_STEP_INTENT_TAG}>`;
}
