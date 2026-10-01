// SPDX-License-Identifier: AGPL-3.0-only
// Réglage Animations (20 § 4.3) : « Système » suit `prefers-reduced-motion`, « Réduites » coupe tout mouvement non essentiel
// (attribut `data-motion="reduced"` de <html>, posé avant le premier rendu par public/theme-init.js, lu par packages/ui/theme.css).
// Le champ `users.motion` du compte est « à valider » (20b § 5, point 6) : à défaut, le choix est mémorisé dans ce navigateur.
export const MOTIONS = ['system', 'reduced'] as const;
export type Motion = (typeof MOTIONS)[number];

export const MOTION_STORAGE_KEY = 'runtime.motion';

export function isMotion(value: unknown): value is Motion {
  return typeof value === 'string' && (MOTIONS as readonly string[]).includes(value);
}

export function readStoredMotion(storage: Pick<Storage, 'getItem'> = localStorage): Motion {
  try {
    const value = storage.getItem(MOTION_STORAGE_KEY);
    return isMotion(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyMotion(motion: Motion, root: HTMLElement = document.documentElement): void {
  if (motion === 'reduced') root.setAttribute('data-motion', 'reduced');
  else root.removeAttribute('data-motion');
}

export function storeMotion(motion: Motion, storage: Pick<Storage, 'setItem'> = localStorage): void {
  try {
    storage.setItem(MOTION_STORAGE_KEY, motion);
  } catch {
    /* stockage indisponible : le choix vaut pour la session seulement */
  }
}
