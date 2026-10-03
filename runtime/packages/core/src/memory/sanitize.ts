// SPDX-License-Identifier: AGPL-3.0-only
// Nettoyage du contenu non fiable de la mémoire (tâche 2.12, 19 §2, r1 R13, r6 R3) : caractères de contrôle, invisibles
// (largeur nulle, trait d'union conditionnel, bloc « tags » U+E0000-E007F), bidirectionnels et balises retirés, puis
// troncature. Les noms de champs sont validés à part (`safeFieldName`).

// Contrôles C0 et C1, DEL, invisibles (largeur nulle, trait d'union conditionnel, sélecteurs de variante, remplissages),
// bidirectionnels et bloc « tags » : comparés par point de code (aucun caractère de contrôle littéral dans une regex).
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c], [0x115f, 0x1160], [0x17b4, 0x17b5],
  [0x180b, 0x180f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];
const invisible = (cp: number): boolean => INVISIBLE_RANGES.some(([a, b]) => cp >= a && cp <= b);
const TAG = /<\/?[A-Za-z!?][^<>]{0,500}>/g;

export function sanitizeUntrusted(text: string, max: number): string {
  const visible = [...text].map((ch) => (ch === '\t' || ch === '\n' || ch === '\r' ? ' ' : invisible(ch.codePointAt(0) ?? 0) ? '' : ch)).join('');
  const clean = visible.replace(TAG, '').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, max).join('');
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const safeFieldName = (name: unknown): name is string => typeof name === 'string' && FIELD.test(name);
