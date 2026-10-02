// SPDX-License-Identifier: AGPL-3.0-only
// Noyau de SYM Browser (cdc/sym-browser 03 § 9) : chiffrement (tâche 0.3), configuration et modes (0.4), journaux masqués.
// Squelette de la tâche 0.1 : seuls les modes de déploiement sont posés (03 § 4).

/** Modes de déploiement : un seul processus (`all`), ou passerelle et nœuds séparés. */
export const SERVICE_MODES = ['all', 'gateway', 'node'] as const;
export type ServiceMode = (typeof SERVICE_MODES)[number];

export function isServiceMode(value: unknown): value is ServiceMode {
  return typeof value === 'string' && (SERVICE_MODES as readonly string[]).includes(value);
}
