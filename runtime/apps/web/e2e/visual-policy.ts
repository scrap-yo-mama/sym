// SPDX-License-Identifier: AGPL-3.0-only
// Régression visuelle par langue (assert_visual_regression_by_locale, part de 3.6 confiée à 3.17) : quand la suite visuelle
// compare, crée ou ne tourne pas. Les instantanés de référence vivent par plateforme (e2e/__visual__/<plateforme>/) parce que
// le rendu du texte diffère d'un système à l'autre. Ceux de linux (plateforme de la CI) ne se créent et ne se comparent que
// dans l'image Playwright épinglée (deploy/Dockerfile), lancée par `pnpm visual:image` : ailleurs sous linux, les polices de
// secours du système changeraient le rendu. En CI, une plateforme sans ses instantanés est une erreur, jamais une
// comparaison passée en silence. Fonction pure, sans I/O.

/**
 * `compare` : chaque capture est comparée à sa référence ; `update` : les références sont (ré)écrites ;
 * `ignore` : poste local d'une plateforme encore sans références, rien n'est comparé ; `excluded` : linux hors de l'image épinglée,
 * la suite visuelle est sautée (elle tourne par `pnpm visual:image`).
 */
export type VisualMode = 'compare' | 'update' | 'ignore' | 'excluded';

export interface VisualContext {
  platform: string;
  /** Variable `CI` posée. */
  ci: boolean;
  /** Le dossier de la plateforme contient des instantanés. */
  hasBaselines: boolean;
  /** `--update-snapshots` demandé. */
  updating: boolean;
  /** Exécution dans l'image Playwright épinglée (`SYM_VISUAL_IMAGE=1`, posé par scripts/visual-image.ts). */
  inImage: boolean;
}

/** Mode de la suite visuelle ; lève une erreur en CI quand la plateforme n'a pas ses instantanés de référence. */
export function visualMode(context: VisualContext): VisualMode {
  if (context.platform === 'linux' && !context.inImage) return 'excluded';
  if (context.updating) return 'update';
  if (context.hasBaselines) return 'compare';
  if (context.ci) {
    throw new Error(
      `assert_visual_regression_by_locale : aucun instantané de référence pour ${context.platform} (e2e/__visual__/${context.platform}/) ; en CI, la régression visuelle doit comparer. Créez-les (${context.platform === 'linux' ? 'pnpm visual:image --update' : 'pnpm test:e2e --update-snapshots'}) et relisez-les.`,
    );
  }
  return 'ignore';
}
