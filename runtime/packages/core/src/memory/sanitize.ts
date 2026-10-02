// SPDX-License-Identifier: AGPL-3.0-only
// Nettoyage du contenu non fiable de la mémoire (tâche 2.12, 19 §2, r1 R13, r6 R3) : caractères de contrôle, invisibles
// (largeur nulle, trait d'union conditionnel, bloc « tags » U+E0000-E007F), bidirectionnels et balises retirés, puis
// troncature. Les noms de champs sont validés à part (`safeFieldName`).

// Contrôles C0 (sauf rien : même les sauts de ligne sont retirés d'une valeur), DEL, C1, invisibles et bidirectionnels.
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￻]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;
const TAG = /<\/?[A-Za-z!?][^<>]{0,500}>/g;

export function sanitizeUntrusted(text: string, max: number): string {
  const clean = text.replace(INVISIBLE, '').replace(TAG, '').replace(/[<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, max).join('');
}

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const safeFieldName = (name: unknown): name is string => typeof name === 'string' && FIELD.test(name);
