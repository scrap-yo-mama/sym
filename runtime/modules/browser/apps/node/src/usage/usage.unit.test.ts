// SPDX-License-Identifier: AGPL-3.0-only
// Comptage mesuré par le nœud (cdc/sym-browser 04d § 4.1, tâche 2.6, BINV5) : durée sur l'horloge monotone du nœud, octets
// cumulés sur toutes les époques de l'egress, journal local `usage.wal` (ajout seul, fsync) rejoué au redémarrage, instantanés
// poussés toutes les 10 s (base de la reconstruction d'un nœud perdu).
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { billedSeconds, createManualClock, createMemorySessionStore, type UsageClosure } from '@sym-browser/core';
import type { EgressPolicy, EgressState } from '@sym/contracts/browser';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { SessionEgress } from '../egress/index.js';
import { meterEgress, replayUsageWal, startUsageSnapshots, UsageMeter, UsageWal } from './index.js';

const egressState = (epoch: number, bytesIn: number, bytesOut: number): EgressState => ({ epoch, requests: 1, blocked: 0, bytesIn, bytesOut, budgetExceeded: false });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'symb-usage-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('UsageMeter', () => {
  test('durée sur l’horloge monotone (un saut de l’horloge murale ne change rien), facturation ceil(ms / 1000)', () => {
    let mono = 1_000;
    let wall = Date.UTC(2026, 9, 2, 10, 0, 0);
    const meter = new UsageMeter({ nodeId: 'node-a', monotonic: () => mono, now: () => wall });
    meter.start('s1');
    mono += 2_001;
    wall -= 3_600_000; // horloge murale recalée en arrière pendant la session
    const closure = meter.stop('s1');
    expect(closure).toEqual({ sessionId: 's1', nodeId: 'node-a', startedAt: Date.UTC(2026, 9, 2, 10, 0, 0), browserMs: 2_001, bytesIn: 0, bytesOut: 0 });
    expect(billedSeconds(closure?.browserMs ?? -1)).toBe(3);
    expect(meter.stop('s1')).toBeUndefined();
  });

  test('octets : cumul des époques (une nouvelle politique remet les compteurs de l’egress à zéro)', () => {
    let mono = 0;
    const meter = new UsageMeter({ nodeId: 'n', monotonic: () => mono, now: () => 0 });
    meter.start('s');
    meter.observe('s', egressState(1, 100, 10));
    meter.observe('s', egressState(1, 400, 40));
    meter.observe('s', egressState(2, 5, 1)); // époque 2 : compteurs repartis de zéro
    meter.observe('s', egressState(2, 50, 7));
    meter.observe('s', egressState(1, 1, 1)); // observation tardive d'une époque close : ignorée si plus petite
    mono = 999;
    expect(meter.live()).toEqual([{ sessionId: 's', nodeId: 'n', startedAt: 0, browserMs: 999, bytesIn: 450, bytesOut: 47 }]);
    expect(meter.stop('s')).toMatchObject({ browserMs: 999, bytesIn: 450, bytesOut: 47 });
    expect(meter.live()).toEqual([]);
  });

  test('observation d’une session inconnue ou déjà close : sans effet', () => {
    const meter = new UsageMeter({ nodeId: 'n', monotonic: () => 0, now: () => 0 });
    meter.observe('absente', egressState(1, 10, 10));
    expect(meter.live()).toEqual([]);
  });
});

describe('meterEgress', () => {
  test('replace et close rendent les compteurs finals de l’époque au compteur AVANT la remise à zéro', async () => {
    let state = egressState(1, 0, 0);
    const seen: EgressState[] = [];
    const fake = {
      url: 'http://127.0.0.1:1',
      port: 1,
      state: () => state,
      replace: (_policy: EgressPolicy) => {
        state = egressState(state.epoch + 1, 0, 0);
        return state;
      },
      connections: () => [],
      abortAll: () => undefined,
      shut: () => undefined,
      close: async () => undefined,
    } satisfies SessionEgress;
    const metered = meterEgress(fake, (s) => seen.push(s));
    state = egressState(1, 300, 30);
    metered.replace({});
    state = egressState(2, 70, 7);
    await metered.close();
    expect(seen).toEqual([egressState(1, 300, 30), egressState(2, 70, 7)]);
    expect(metered.state()).toEqual(egressState(2, 70, 7));
  });
});

describe('UsageWal (usage.wal)', () => {
  const closure = (n: number): UsageClosure => ({ sessionId: `00000000-0000-4000-8000-00000000000${n}`, nodeId: 'node-a', startedAt: 1_700_000_000_000 + n, browserMs: 1000 * n + 1, bytesIn: n, bytesOut: 2 * n });

  test('ajout seul, sur disque dès le retour d’append (fsync), relu dans l’ordre', async () => {
    const path = join(dir, 'usage.wal');
    const wal = await UsageWal.open(path);
    await wal.append(closure(1));
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
    await wal.append(closure(2));
    await wal.close();
    const again = await UsageWal.open(path);
    await again.append(closure(3));
    expect(await again.read()).toEqual([closure(1), closure(2), closure(3)]);
    await again.close();
  });

  test('dernière ligne déchirée (arrêt brutal pendant l’écriture) : ignorée, les clôtures complètes restent', async () => {
    const path = join(dir, 'usage.wal');
    writeFileSync(path, `${JSON.stringify(closure(1))}\n`);
    appendFileSync(path, '{"sessionId":"00000000-0000-4000-8000-0000000');
    const wal = await UsageWal.open(path);
    expect(await wal.read()).toEqual([closure(1)]);
    // L'ajout suivant commence sur une ligne neuve : la clôture n'est pas collée au fragment.
    await wal.append(closure(2));
    expect(await wal.read()).toEqual([closure(1), closure(2)]);
    await wal.close();
  });

  test('rejeu au redémarrage : chaque clôture est réécrite (idempotent), les inconnues comptées', async () => {
    const wal = await UsageWal.open(join(dir, 'usage.wal'));
    const store = createMemorySessionStore();
    store.create({ sessionId: closure(1).sessionId, createdAt: 0, expiresAt: 10_000 });
    await wal.append(closure(1));
    await wal.append(closure(2));
    expect(await replayUsageWal(wal, store)).toEqual({ inserted: 1, replaced: 0, unchanged: 0, notFound: 1 });
    expect(await replayUsageWal(wal, store)).toEqual({ inserted: 0, replaced: 0, unchanged: 1, notFound: 1 });
    expect(store.usage(closure(1).sessionId)).toEqual({ ...closure(1), source: 'node' });
    await wal.close();
  });
});

describe('instantanés (startUsageSnapshots)', () => {
  test('toutes les intervalMs, mesures en cours poussées ; arrêt : plus aucune écriture', async () => {
    const clock = createManualClock(0);
    const meter = new UsageMeter({ nodeId: 'n', monotonic: () => clock.now(), now: () => 1_000 + clock.now() });
    const pushed: UsageClosure[][] = [];
    const snapshots = startUsageSnapshots({ meter, write: async (s) => void pushed.push(s), clock, intervalMs: 10_000 });
    meter.start('s');
    meter.observe('s', egressState(1, 10, 1));
    clock.advance(10_000);
    clock.advance(10_000);
    snapshots.stop();
    clock.advance(10_000);
    expect(pushed).toEqual([
      [{ sessionId: 's', nodeId: 'n', startedAt: 1_000, browserMs: 10_000, bytesIn: 10, bytesOut: 1 }],
      [{ sessionId: 's', nodeId: 'n', startedAt: 1_000, browserMs: 20_000, bytesIn: 10, bytesOut: 1 }],
    ]);
  });
});
