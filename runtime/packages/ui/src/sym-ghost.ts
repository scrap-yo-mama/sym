// SPDX-License-Identifier: AGPL-3.0-only
// Icône SYM 👻 (20 § 2.3) : un seul tracé pour la console, le panneau de l'extension et le site de doc. Le fichier de
// référence est icons/sym-ghost.svg (en `currentColor`, sans texte, sans style) ; ces constantes en sont la copie
// exploitable par les composants et par les fonctions de rendu, et un test garde l'égalité des deux (assert_svg_safe).

/** `viewBox` de l'icône. */
export const SYM_GHOST_VIEWBOX = '0 0 24 24';

/** Tracé de l'icône : silhouette pleine, yeux évidés (`fill-rule="evenodd"`). */
export const SYM_GHOST_PATH =
  'M12 2.5c-4.14 0-7.5 3.36-7.5 7.5v10.2c0 .92 1.1 1.4 1.77.77l1.93-1.77 2.1 1.9a2.4 2.4 0 0 0 3.4 0l2.1-1.9 1.93 1.77c.67.63 1.77.15 1.77-.77V10c0-4.14-3.36-7.5-7.5-7.5ZM9.25 8.75a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Zm5.5 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z';
