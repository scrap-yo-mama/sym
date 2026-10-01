// SPDX-License-Identifier: AGPL-3.0-only
// Compatibilité code / schéma (14 § 5-6) : `server` et `worker` refusent de démarrer si le schéma n'est pas celui
// qu'ils attendent. Schéma en retard : `runtime migrate`. Schéma en avance : image plus ancienne que la base, donc
// retour d'image sans restauration ; la seule issue est la sauvegarde prise avant la migration (14 § 6, point 6).

export type SchemaCompatibility = 'ok' | 'behind' | 'ahead';

export function schemaCompatibility(found: number, expected: number): SchemaCompatibility {
  return found === expected ? 'ok' : found < expected ? 'behind' : 'ahead';
}

/** Message de refus, ou null si le schéma convient. `role` nomme la commande qui refuse. */
export function schemaVersionRefusal(found: number, expected: number, role: 'server' | 'worker'): string | null {
  switch (schemaCompatibility(found, expected)) {
    case 'ok':
      return null;
    case 'behind':
      return `schéma de base en version ${found}, ${expected} attendue : lancez \`runtime migrate\` avant \`${role}\`.`;
    case 'ahead':
      return (
        `schéma de base en version ${found}, ce code n'attend que la version ${expected} : l'image est plus ancienne que la base. ` +
        'Pas de migration descendante en production : redéployez l\'image récente, ou restaurez la sauvegarde prise avant la mise à jour ' +
        '(retour arrière = image précédente + restauration).'
      );
  }
}
