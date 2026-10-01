// SPDX-License-Identifier: AGPL-3.0-only
// Copie dans le presse-papiers (exemples d'appel, modèle de demande d'accès). Échoue sans bruit hors contexte sécurisé :
// l'appelant affiche alors que la copie n'a pas eu lieu.

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
