// SPDX-License-Identifier: AGPL-3.0-only
// Retour du focus à l'élément qui a ouvert un panneau (WCAG 2.4.3). Le panneau prend le focus à l'ouverture ; à la fermeture
// il le rend, sinon le focus tombe sur <body> et la personne au clavier repart du haut de la page.

/** L'élément qui a le focus au moment où un panneau s'ouvre : l'ouvreur. `null` si le focus est sur <body> ou nulle part. */
export function captureOpener(doc: Pick<Document, 'activeElement' | 'body'> | undefined = typeof document === 'undefined' ? undefined : document): HTMLElement | null {
  // Rendu côté serveur (tests sans navigateur) : pas de document, pas d'ouvreur.
  const active = doc?.activeElement;
  return doc && active && active !== doc.body ? (active as HTMLElement) : null;
}

/** Rend le focus à l'ouvreur s'il est encore dans la page ; sinon ne fait rien (la page a changé, il n'y a plus rien à rejoindre). */
export function returnFocus(opener: HTMLElement | null): void {
  if (opener?.isConnected) opener.focus();
}
