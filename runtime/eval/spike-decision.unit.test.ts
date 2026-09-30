// Tâche 0.6a : le protocole du spike est figé avant les runs ; toute modification exige de mettre à jour
// l'empreinte stockée (15 §11 : « empreinte vérifiée en CI »).
import { describe, expect, test } from 'vitest';
import {
  DECISION_FILE,
  computeDecisionHash,
  formatHashLine,
  parseHashLine,
  readStoredHash,
  sha256Hex,
} from './scripts/spike-decision-hash.ts';

describe('protocole du spike 0.6a', () => {
  test('sha256Hex et le format sha256sum', () => {
    // Vecteur connu : SHA-256 de la chaîne vide.
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const line = formatHashLine('a'.repeat(64));
    expect(line).toBe(`${'a'.repeat(64)}  ${DECISION_FILE}\n`);
    expect(parseHashLine(line)).toEqual({ hex: 'a'.repeat(64), name: DECISION_FILE });
    expect(parseHashLine('pas une empreinte')).toBeNull();
    expect(parseHashLine(`${'A'.repeat(64)}  x.md`)).toBeNull();
  });

  test('un octet modifié change l\'empreinte', () => {
    expect(sha256Hex('seuil 60 %')).not.toBe(sha256Hex('seuil 50 %'));
    expect(sha256Hex('a\n')).not.toBe(sha256Hex('a\r\n'));
  });

  test('assert_spike_decision_frozen : le fichier de décision correspond à l\'empreinte stockée', () => {
    const stored = readStoredHash();
    expect(stored, 'spike-0.6a-decision.sha256 illisible').not.toBeNull();
    expect(stored?.name).toBe(DECISION_FILE);
    // En cas d'échec : le protocole a changé. Si c'est voulu (et avant le premier run compté, §16),
    // lancer `node eval/scripts/spike-decision-hash.ts --write` et commiter les deux fichiers ensemble.
    expect(computeDecisionHash()).toBe(stored?.hex);
  });
});
