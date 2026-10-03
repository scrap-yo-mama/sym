// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 0.6 : constantes de capacité d'un nœud (cdc/sym-browser 04b §3), fixées par les mesures de bench/results/.
import { describe, expect, test } from 'vitest';
import { CAPACITY, computeSlotUnits, computeSlots, sessionUnits } from './capacity.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

describe('capacité d’un nœud (04b §3)', () => {
  test('slots = max(1, floor((limite − base) / budget par slot)) : 2 Go, 4 Go, 8 Go', () => {
    const slots = (limiteGo: number): number => computeSlots(limiteGo * GIB);
    expect(slots(2)).toBe(Math.max(1, Math.floor((2 * GIB - CAPACITY.BASE_BYTES) / CAPACITY.SLOT_BYTES)));
    expect(slots(4)).toBe(Math.floor((4 * GIB - CAPACITY.BASE_BYTES) / CAPACITY.SLOT_BYTES));
    expect(slots(8)).toBe(Math.floor((8 * GIB - CAPACITY.BASE_BYTES) / CAPACITY.SLOT_BYTES));
    expect(slots(8)).toBeGreaterThan(slots(4));
    expect(slots(4)).toBeGreaterThan(slots(2));
  });

  test('un nœud a toujours au moins un slot, même sous la base', () => {
    expect(computeSlots(0)).toBe(1);
    expect(computeSlots(CAPACITY.BASE_BYTES)).toBe(1);
    expect(computeSlots(256 * MIB)).toBe(1);
  });

  test('poids : dedicated = 1 slot entier, shared ≤ dedicated, en unités entières (réservation atomique en SQL)', () => {
    expect(sessionUnits('dedicated')).toBe(CAPACITY.SLOT_UNITS);
    expect(sessionUnits('shared')).toBeLessThanOrEqual(sessionUnits('dedicated'));
    expect(sessionUnits('shared')).toBeGreaterThan(0);
    for (const value of [CAPACITY.SLOT_UNITS, sessionUnits('shared'), CAPACITY.CONTEXTS_PER_BROWSER]) expect(Number.isInteger(value)).toBe(true);
  });

  test('unités totales = slots × unités par slot', () => {
    expect(computeSlotUnits(4 * GIB)).toBe(computeSlots(4 * GIB) * CAPACITY.SLOT_UNITS);
  });

  test('contextes shared par Chromium chaud : de 2 à 8 (aucune dégradation mesurée au-delà de 1, jusqu’à 8)', () => {
    expect(CAPACITY.CONTEXTS_PER_BROWSER).toBeGreaterThanOrEqual(2);
    expect(CAPACITY.CONTEXTS_PER_BROWSER).toBeLessThanOrEqual(8);
  });
});
