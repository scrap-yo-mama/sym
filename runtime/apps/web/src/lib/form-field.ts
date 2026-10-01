// SPDX-License-Identifier: AGPL-3.0-only
// Valeur réelle d'un champ au moment de l'envoi. L'autoremplissage du navigateur (mot de passe enregistré) remplit un
// champ sans déclencher l'événement `input` : la `ref` Vue liée au champ reste vide alors que l'utilisateur voit une
// valeur. Au submit, c'est donc le DOM qui fait foi ; la `ref` ne sert que sans DOM (rendu serveur, tests) ou si le
// champ est introuvable.

/** Valeur du champ `name` du formulaire, sinon `fallback` (valeur de la `ref`). */
export function readFieldValue(form: HTMLFormElement | null | undefined, name: string, fallback: string): string {
  const field = form?.elements?.namedItem(name);
  return field !== null && field !== undefined && 'value' in field && typeof field.value === 'string' ? field.value : fallback;
}
