// SPDX-License-Identifier: AGPL-3.0-only
// Valeur réelle d'un champ au moment de l'envoi. L'autoremplissage du navigateur (mot de passe enregistré) remplit un
// champ sans déclencher l'événement `input` : la `ref` Vue liée au champ reste vide alors que l'utilisateur voit une
// valeur. Au submit, c'est donc le DOM qui fait foi ; la `ref` ne sert que sans DOM (rendu serveur, tests) ou si le
// champ est introuvable.

import type { Ref } from 'vue';

/** Valeur du champ `name` du formulaire, sinon `fallback` (valeur de la `ref`). */
export function readFieldValue(form: HTMLFormElement | null | undefined, name: string, fallback: string): string {
  const field = form?.elements?.namedItem(name);
  return field !== null && field !== undefined && 'value' in field && typeof field.value === 'string' ? field.value : fallback;
}

/**
 * Lit puis efface un champ secret au submit : renvoie la valeur du DOM (sinon celle de la `ref`), puis vide le champ du DOM
 * et la `ref` dans tous les cas, y compris quand le DOM est vide mais que la `ref` garde une ancienne saisie.
 */
export function takeFieldValue(form: HTMLFormElement | null | undefined, name: string, model: Ref<string>): string {
  const value = readFieldValue(form, name, model.value);
  model.value = '';
  const field = form?.elements?.namedItem(name);
  if (field !== null && field !== undefined && 'value' in field && typeof field.value === 'string') field.value = '';
  return value;
}
