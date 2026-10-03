// SPDX-License-Identifier: AGPL-3.0-only
// Bras du banc pour l'intelligence de l'agent (19, 15 §11). Un bras dont la fonction n'est pas encore fusionnée reste en
// `test.todo` (10-taches, ligne 2.8) et est joué par sa tâche ou en 4.2 ; les bras actifs ont leurs tests ailleurs
// (corpus d'injection : n0.eval.test.ts et fixtures).
import { describe, expect, test } from 'vitest';
import { ARMS } from './catalog.ts';

describe('bras déclarés du banc', () => {
  for (const arm of ARMS.filter((a) => a.status === 'pending')) {
    test.todo(`bras ${arm.id} (${arm.variants.join(', ')}) — en attente de ${arm.requires.join(', ')}`);
  }

  test('chaque bras en attente nomme sa tâche et ses variantes ; chaque bras actif a une mesure', () => {
    for (const arm of ARMS) {
      expect(arm.variants.length, arm.id).toBeGreaterThan(0);
      expect(arm.measures.length, arm.id).toBeGreaterThan(0);
      if (arm.status === 'pending') expect(arm.requires.every((t) => /^\d+\.\d+$/.test(t)), arm.id).toBe(true);
    }
  });

  // Tests nommés du banc dont la fonction n'est pas fusionnée (15 §12) : joués par 2.12 et 2.14, puis en 4.2.
  test.todo('assert_silent_defects_detected — ablation à 4 bras de la fiche de qualité sur 11 défauts injectés (2.12)');
  test.todo('assert_brief_ab_paired — huit bras du dossier d’enquête, mesures appariées avec intervalle, porte pré-enregistrée (2.14)');
});
