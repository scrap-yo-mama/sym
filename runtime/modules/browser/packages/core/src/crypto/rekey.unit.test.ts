// SPDX-License-Identifier: AGPL-3.0-only
// Rekey complet (tâche 0.3, BINV6) : toutes les valeurs passent de MASTER_KEY_PREVIOUS à MASTER_KEY, reprise après
// interruption, témoin réécrit, refus clairs. Dépôt en mémoire au contrat de `RekeyStore` (l'adaptateur PostgreSQL suit
// le schéma de la tâche 0.2).
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, test } from 'vitest';
import { kekFor, openSecretBytes, profileAad, proxyProfileAad, sealSecret, SecretDecryptError, type SealedValue } from './envelope.js';
import { createKeyCheck, verifyKeyCheck, type KeyCheckRecord } from './key-check.js';
import { generateMasterKey, MasterKey, type Keyring } from './master-key.js';
import { assertKeyCheck, KeyCheckError, rekey, type RekeyState, type RekeyStore, type StoredSealed } from './rekey.js';

const newKey = () => MasterKey.parse(generateMasterKey());

type Row = { aad: string; sealed: SealedValue; state: 'ok' | 'unreadable'; plain: Buffer };

/** Dépôt en mémoire : chaque `commit` et `finish` est atomique (tout ou rien), comme une transaction. */
class MemoryStore implements RekeyStore {
  rows = new Map<string, Row>();
  keyCheck: KeyCheckRecord | undefined;
  state: RekeyState | undefined;
  failCommitAt: number | undefined;
  commits = 0;

  async readKeyCheck() {
    return this.keyCheck;
  }
  async readState() {
    return this.state;
  }
  async writeState(state: RekeyState) {
    this.state = { ...state };
  }
  async pending(version: number, limit: number): Promise<StoredSealed[]> {
    return [...this.rows.entries()]
      .filter(([, r]) => r.state === 'ok' && r.sealed.kekVersion === version)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, limit)
      .map(([id, r]) => ({ id, aad: r.aad, sealed: r.sealed }));
  }
  async commit(batch: { rotated: { id: string; sealed: SealedValue }[]; unreadable: string[] }) {
    this.commits += 1;
    if (this.commits === this.failCommitAt) throw new Error('coupure simulée pendant la transaction');
    for (const { id, sealed } of batch.rotated) this.rows.get(id)!.sealed = sealed;
    for (const id of batch.unreadable) this.rows.get(id)!.state = 'unreadable';
  }
  async finish(record: KeyCheckRecord, from: number) {
    if ((await this.pending(from, 1)).length > 0) throw new Error('valeurs restantes sous l’ancienne version');
    this.keyCheck = record;
    this.state = undefined;
  }
}

function seed(store: MemoryStore, master: MasterKey, version: number, count: number) {
  const kek = kekFor(master, version);
  store.keyCheck = createKeyCheck(master, version);
  for (let i = 0; i < count; i += 1) {
    const id = `row-${String(i).padStart(4, '0')}`;
    const aad = i % 2 === 0 ? proxyProfileAad({ tenantId: 't1', profileId: id }) : profileAad({ tenantId: 't1', profileId: id, version: 1 });
    const plain = i % 2 === 0 ? Buffer.from(`zz_test_canary_${randomBytes(6).toString('hex')}`) : randomBytes(256);
    store.rows.set(id, { aad, sealed: sealSecret(plain, kek, aad), state: 'ok', plain });
  }
}

describe('assert_secrets_protected — rekey complet (tâche 0.3)', () => {
  let oldKey: MasterKey;
  let newK: MasterKey;
  let store: MemoryStore;
  let ring: Keyring;

  beforeEach(() => {
    [oldKey, newK] = [newKey(), newKey()];
    store = new MemoryStore();
    seed(store, oldKey, 1, 25);
    ring = { current: newK, previous: oldKey };
  });

  function assertComplete(version: number, expectedUnreadable = 0) {
    const toKek = kekFor(newK, version);
    const fromKek = kekFor(oldKey, version - 1);
    let unreadable = 0;
    for (const [id, row] of store.rows) {
      if (row.state === 'unreadable') {
        unreadable += 1;
        continue;
      }
      expect(row.sealed.kekVersion, id).toBe(version);
      expect(openSecretBytes(row.sealed, toKek, row.aad).equals(row.plain), id).toBe(true);
      expect(() => openSecretBytes(row.sealed, fromKek, row.aad), id).toThrow(SecretDecryptError);
    }
    expect(unreadable).toBe(expectedUnreadable);
    expect(store.state).toBeUndefined();
    expect(store.keyCheck?.version).toBe(version);
    expect(verifyKeyCheck(store.keyCheck!, newK)).toBe(true);
    expect(verifyKeyCheck(store.keyCheck!, oldKey)).toBe(false);
  }

  test('en une passe : toutes les valeurs sous la nouvelle clé (v1 → v2), témoin réécrit, ancienne clé inutile', async () => {
    const progress: number[] = [];
    const res = await rekey(store, ring, { batchSize: 10, afterBatch: (n) => void progress.push(n) });
    expect(res).toEqual({ status: 'done', from: 1, to: 2, rotated: 25, unreadable: 0 });
    expect(progress).toEqual([10, 20, 25]);
    assertComplete(2);
    expect(assertKeyCheck(store.keyCheck, store.state, newK)).toEqual({ version: 2, fingerprint: newK.fingerprint });
    expect(() => assertKeyCheck(store.keyCheck, store.state, oldKey)).toThrow(/ne correspond pas/);
  });

  test('relancé après la fin : rien à faire', async () => {
    await rekey(store, ring, { batchSize: 7 });
    const before = new Map([...store.rows].map(([id, r]) => [id, r.sealed.ciphertext.toString('hex')]));
    expect(await rekey(store, ring)).toEqual({ status: 'already_done', from: 2, to: 2, rotated: 0, unreadable: 0 });
    for (const [id, r] of store.rows) expect(r.sealed.ciphertext.toString('hex')).toBe(before.get(id));
  });

  test('interrompu entre deux lots puis repris : complet, démarrage refusé entre-temps', async () => {
    await expect(
      rekey(store, ring, {
        batchSize: 10,
        afterBatch: () => {
          throw new Error('arrêt du processus simulé');
        },
      }),
    ).rejects.toThrow(/arrêt du processus/);
    expect(store.state).toMatchObject({ from: 1, to: 2, fromFingerprint: oldKey.fingerprint, toFingerprint: newK.fingerprint });
    expect([...store.rows.values()].filter((r) => r.sealed.kekVersion === 2)).toHaveLength(10);
    // Rotation inachevée : aucun service ne démarre, ni avec l'ancienne ni avec la nouvelle clé.
    for (const key of [oldKey, newK]) expect(() => assertKeyCheck(store.keyCheck, store.state, key)).toThrow(/rotation de clé inachevée/);
    const res = await rekey(store, ring, { batchSize: 10 });
    expect(res).toMatchObject({ status: 'done', from: 1, to: 2, rotated: 15 });
    assertComplete(2);
  });

  test('coupure pendant un lot (transaction annulée) puis reprise : complet', async () => {
    store.failCommitAt = 2;
    await expect(rekey(store, ring, { batchSize: 10 })).rejects.toThrow(/coupure simulée/);
    expect([...store.rows.values()].filter((r) => r.sealed.kekVersion === 2)).toHaveLength(10);
    store.failCommitAt = undefined;
    await rekey(store, ring, { batchSize: 10 });
    assertComplete(2);
  });

  test('reprise avec une autre nouvelle clé : refus, rien n’est touché', async () => {
    await expect(rekey(store, ring, { batchSize: 10, afterBatch: () => Promise.reject(new Error('stop')) })).rejects.toThrow('stop');
    const other = newKey();
    await expect(rekey(store, { current: other, previous: oldKey })).rejects.toThrow(new RegExp(`déjà commencée vers l’empreinte ${newK.fingerprint}`));
    expect([...store.rows.values()].every((r) => r.sealed.kekVersion !== 3)).toBe(true);
  });

  test('valeur que l’ancienne clé n’ouvre pas : marquée illisible, gardée, jamais effacée ; le reste est complet', async () => {
    const victim = store.rows.get('row-0003')!;
    const flipped = Buffer.from(victim.sealed.ciphertext);
    flipped[0] = flipped[0]! ^ 1;
    victim.sealed = { ...victim.sealed, ciphertext: flipped };
    const res = await rekey(store, ring, { batchSize: 4 });
    expect(res).toMatchObject({ status: 'done', rotated: 24, unreadable: 1 });
    expect(store.rows.get('row-0003')).toMatchObject({ state: 'unreadable', sealed: { kekVersion: 1 } });
    assertComplete(2, 1);
  });

  test('deux rotations successives : v1 → v2 → v3', async () => {
    await rekey(store, ring);
    const third = newKey();
    const res = await rekey(store, { current: third, previous: newK });
    expect(res).toMatchObject({ status: 'done', from: 2, to: 3, rotated: 25 });
    for (const row of store.rows.values()) expect(openSecretBytes(row.sealed, kekFor(third, 3), row.aad).equals(row.plain)).toBe(true);
  });

  test('refus clairs : sans MASTER_KEY_PREVIOUS, clés identiques, ancienne clé fausse, témoin absent', async () => {
    await expect(rekey(store, { current: newK })).rejects.toThrow(/MASTER_KEY_PREVIOUS .*requise/);
    await expect(rekey(store, { current: oldKey, previous: oldKey })).rejects.toThrow(/identiques/);
    await expect(rekey(store, { current: newK, previous: newKey() })).rejects.toThrow(/MASTER_KEY_PREVIOUS ne correspond pas/);
    store.keyCheck = undefined;
    await expect(rekey(store, ring)).rejects.toThrow(KeyCheckError);
    expect(store.state).toBeUndefined();
  });

  test('dépôt défaillant qui rend deux fois la même ligne : arrêt, pas de boucle infinie', async () => {
    const stuck: RekeyStore = { ...bind(store), commit: async () => {} };
    await expect(rekey(stuck, ring, { batchSize: 5 })).rejects.toThrow(/deux fois/);
  });

  test('ligne rendue sous une autre version : arrêt', async () => {
    const wrong: RekeyStore = {
      ...bind(store),
      pending: async (v, l) => (await store.pending(v, l)).map((r) => ({ ...r, sealed: { ...r.sealed, kekVersion: 9 } })),
    };
    await expect(rekey(wrong, ring)).rejects.toThrow(/version/);
  });

  test('aucun message d’erreur ne contient une clé ni une valeur', async () => {
    const messages: string[] = [];
    for (const attempt of [() => rekey(store, { current: newK, previous: newKey() }), () => rekey(store, { current: oldKey, previous: oldKey })]) {
      await attempt().catch((error: Error) => messages.push(error.message));
    }
    const all = messages.join('\n');
    for (const key of [oldKey, newK]) expect(all).not.toContain(key.exportBase64());
    for (const row of store.rows.values()) expect(all).not.toContain(row.plain.toString('utf8'));
  });
});

describe('assertKeyCheck (contrôle de démarrage)', () => {
  test('témoin absent : à créer ; bonne clé : version ; autre clé : refus nommant les empreintes', () => {
    const key = newKey();
    expect(assertKeyCheck(undefined, undefined, key)).toEqual({ version: undefined, fingerprint: key.fingerprint });
    const record = createKeyCheck(key, 4);
    expect(assertKeyCheck(record, undefined, key)).toEqual({ version: 4, fingerprint: key.fingerprint });
    const other = newKey();
    expect(() => assertKeyCheck(record, undefined, other)).toThrow(KeyCheckError);
    expect(() => assertKeyCheck(record, undefined, other)).toThrow(new RegExp(`${key.fingerprint}.*${other.fingerprint}`));
  });

  test('rotation inachevée : refus nommant les versions et la commande de reprise', () => {
    const key = newKey();
    const state: RekeyState = { from: 1, to: 2, fromFingerprint: 'aaaa-bbbb-cccc', toFingerprint: key.fingerprint };
    expect(() => assertKeyCheck(createKeyCheck(key, 1), state, key)).toThrow(/rotation de clé inachevée \(version 1 → 2.*rekey/);
  });
});

function bind(store: MemoryStore): RekeyStore {
  return {
    readKeyCheck: () => store.readKeyCheck(),
    readState: () => store.readState(),
    writeState: (s) => store.writeState(s),
    pending: (v, l) => store.pending(v, l),
    commit: (b) => store.commit(b),
    finish: (r, f) => store.finish(r, f),
  };
}
