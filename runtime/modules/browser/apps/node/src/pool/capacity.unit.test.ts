// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.1 (04b § 3, P2) : capacité du nœud déduite de la limite mémoire du cgroup, slots par type de session.
import { describe, expect, test } from 'vitest';
import {
  CGROUP_V1_MEMORY_LIMIT,
  CGROUP_V1_MEMORY_STAT,
  CGROUP_V1_MEMORY_USAGE,
  CGROUP_V2_MEMORY_CURRENT,
  CGROUP_V2_MEMORY_MAX,
  CGROUP_V2_MEMORY_STAT,
  PROVISIONAL_CAPACITY,
  SLOT_UNITS,
  memoryUsage,
  memoryHighProbe,
  resolveCapacity,
  sessionWeightUnits,
  slotsForMemory,
  type FileReader,
} from './capacity.js';

const GIB = 1024 ** 3;
const files =
  (content: Record<string, string>): FileReader =>
  (path) =>
    content[path];

describe('capacity_from_cgroup : slots déduits de la limite mémoire du cgroup (04b § 3, P2)', () => {
  test('formule de départ : 2 Go → 1 slot, 4 Go → 2, 8 Go → 5 ; jamais moins de 1', () => {
    expect(slotsForMemory(2 * GIB)).toBe(1);
    expect(slotsForMemory(4 * GIB)).toBe(2);
    expect(slotsForMemory(8 * GIB)).toBe(5);
    expect(slotsForMemory(512 * 1024 ** 2)).toBe(1);
  });

  test('cgroup v2 (memory.max), puis v1 (memory.limit_in_bytes), puis mémoire de la machine', () => {
    for (const [gib, slots] of [[2, 1], [4, 2], [8, 5]] as const) {
      expect(resolveCapacity({ maxSessions: null }, { read: files({ [CGROUP_V2_MEMORY_MAX]: `${gib * GIB}\n` }) })).toEqual({ slotsTotal: slots, source: 'cgroup', limitBytes: gib * GIB });
      expect(resolveCapacity({ maxSessions: null }, { read: files({ [CGROUP_V1_MEMORY_LIMIT]: `${gib * GIB}` }) })).toEqual({ slotsTotal: slots, source: 'cgroup', limitBytes: gib * GIB });
    }
    // v2 sans limite (`max`) et v1 sans limite (≈ 2^63) : la mémoire de la machine.
    const unlimited = files({ [CGROUP_V2_MEMORY_MAX]: 'max\n', [CGROUP_V1_MEMORY_LIMIT]: '9223372036854771712' });
    expect(resolveCapacity({ maxSessions: null }, { read: unlimited, totalMemBytes: 8 * GIB })).toEqual({ slotsTotal: 5, source: 'host', limitBytes: 8 * GIB });
    expect(resolveCapacity({ maxSessions: null }, { read: files({}), totalMemBytes: 4 * GIB })).toEqual({ slotsTotal: 2, source: 'host', limitBytes: 4 * GIB });
  });

  test('MAX_SESSIONS remplace la valeur calculée (la limite reste lue pour le recyclage mémoire)', () => {
    expect(resolveCapacity({ maxSessions: 7 }, { read: files({ [CGROUP_V2_MEMORY_MAX]: `${2 * GIB}` }) })).toEqual({ slotsTotal: 7, source: 'env', limitBytes: 2 * GIB });
  });

  test('constantes PROVISOIRES (à remplacer par la tâche 0.6) : valeurs de départ de 04b § 3, remplaçables sans changer le code', () => {
    expect(PROVISIONAL_CAPACITY).toEqual({
      baseBytes: 0.5 * GIB,
      slotBytes: 1.5 * GIB,
      weights: { dedicated: 1, shared: 1 },
      contextsPerBrowser: 4,
      measuredBy: null,
    });
    expect(Object.isFrozen(PROVISIONAL_CAPACITY)).toBe(true);
    // Point d'accroche 0.6 : des constantes mesurées (docs/mesures-capacite.md) remplacent les provisoires.
    const measured = { ...PROVISIONAL_CAPACITY, slotBytes: 1 * GIB, measuredBy: 'docs/mesures-capacite.md' };
    expect(slotsForMemory(4 * GIB, measured)).toBe(3);
    expect(resolveCapacity({ maxSessions: null }, { read: files({ [CGROUP_V2_MEMORY_MAX]: `${4 * GIB}` }), constants: measured }).slotsTotal).toBe(3);
  });

  test('slots par type de session : poids en unités entières (un slot = SLOT_UNITS), poids fractionnaire accepté', () => {
    expect(sessionWeightUnits('dedicated')).toBe(SLOT_UNITS);
    expect(sessionWeightUnits('shared')).toBe(SLOT_UNITS);
    const constants = { ...PROVISIONAL_CAPACITY, weights: { dedicated: 1, shared: 0.25 } };
    expect(sessionWeightUnits('shared', constants)).toBe(SLOT_UNITS / 4);
    expect(() => sessionWeightUnits('shared', { ...PROVISIONAL_CAPACITY, weights: { dedicated: 1, shared: 0 } })).toThrow(RangeError);
    expect(() => sessionWeightUnits('dedicated', { ...PROVISIONAL_CAPACITY, weights: { dedicated: 1.5, shared: 1 } })).toThrow(RangeError);
  });
});

describe('mémoire de travail du cgroup (recyclage par mémoire, 04b § 4)', () => {
  test('consommation moins le cache inactif, v2 puis v1 ; seuil en pourcentage de la limite', () => {
    const v2 = files({ [CGROUP_V2_MEMORY_MAX]: `${4 * GIB}`, [CGROUP_V2_MEMORY_CURRENT]: `${4 * GIB}`, [CGROUP_V2_MEMORY_STAT]: `anon 1\ninactive_file ${1 * GIB}\n` });
    expect(memoryUsage({ read: v2 })).toEqual({ workingSetBytes: 3 * GIB, limitBytes: 4 * GIB });
    const v1 = files({ [CGROUP_V1_MEMORY_LIMIT]: `${2 * GIB}`, [CGROUP_V1_MEMORY_USAGE]: `${2 * GIB}`, [CGROUP_V1_MEMORY_STAT]: `total_inactive_file ${GIB / 2}\n` });
    expect(memoryUsage({ read: v1 })).toEqual({ workingSetBytes: 1.5 * GIB, limitBytes: 2 * GIB });
    expect(memoryHighProbe(90, { read: v2 })()).toBe(false);
    expect(memoryHighProbe(75, { read: v2 })()).toBe(true);
    const full = files({ [CGROUP_V2_MEMORY_MAX]: `${10 * GIB}`, [CGROUP_V2_MEMORY_CURRENT]: `${9 * GIB}` });
    expect(memoryHighProbe(90, { read: full })()).toBe(true);
  });

  test('hors cgroup : mémoire de la machine (totale moins libre)', () => {
    expect(memoryUsage({ read: files({}), totalMemBytes: 8 * GIB, freeMemBytes: 2 * GIB })).toEqual({ workingSetBytes: 6 * GIB, limitBytes: 8 * GIB });
  });
});
