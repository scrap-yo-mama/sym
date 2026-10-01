// SPDX-License-Identifier: AGPL-3.0-only
// Instance de test peuplée pour les épreuves d'exploitation (4.6) : sauvegarde / restauration, montée N-1 → N, retour
// arrière. Les INSERT n'emploient que des colonnes présentes avant ET après la dernière migration.
import { randomBytes, randomUUID } from 'node:crypto';
import { type Keyring } from '@runtime/core';
import { keyCheck, secretStore } from '@runtime/db';
import pg from 'pg';

export type SeededInstance = {
  ownerId: string;
  memberId: string;
  apiIds: { healthy: string[]; other: string[] };
  runIds: string[];
  /** Dataset épinglé : sur un schéma d'avant 0009, `pinned_reason` et `pinned_until` n'existent pas et la montée les remplit. */
  pinned: { datasetId: string; backfilledByMigration: boolean; reason: string };
  /** Valeur en clair de chaque secret, par identifiant (pour prouver le déchiffrement après coup). */
  secrets: Map<string, string>;
};

/** Jeton unique et reconnaissable : aucune valeur réelle dans le dépôt (règle 11). */
export const canary = (label: string) => `zz_test_${label}_${randomBytes(8).toString('hex')}`;

export async function seedInstance(url: string, keyring: Keyring): Promise<SeededInstance> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const ownerId = randomUUID();
    const memberId = randomUUID();
    for (const [id, email, role] of [[ownerId, 'zz_test_owner@example.test', 'owner'], [memberId, 'zz_test_member@example.test', 'member']]) {
      await client.query("INSERT INTO users (id, email, role, status, email_verified) VALUES ($1, $2, $3, 'active', true)", [id, email, role]);
    }
    const checked = await keyCheck(client, keyring);
    const store = secretStore(client, keyring, checked);
    const secrets = new Map<string, string>();
    for (const [owner, kind] of [[null, 'llm_api_key'], [null, 'proxy_credentials'], [memberId, 'webhook_signing']] as const) {
      const value = canary(kind);
      secrets.set(await store.put({ ownerId: owner, kind, label: `zz_test_${kind}`, value }), value);
    }

    const apiIds = { healthy: [] as string[], other: [] as string[] };
    const statuses = ['sain', 'sain', 'warning', 'erreur', 'enquete'] as const;
    for (const [i, status] of statuses.entries()) {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO apis (slug, owner_id, status, status_reason, current_strategy_version, description, purpose)
         VALUES ($1, $2, $3, $4, 1, $5, 'zz_test finalité') RETURNING id`,
        [`zz_test_api_${i}`, i % 2 === 0 ? ownerId : memberId, status, status === 'sain' ? 'strategy_conform' : null, `zz_test API n° ${i}`],
      );
      const id = rows[0]!.id;
      (status === 'sain' ? apiIds.healthy : apiIds.other).push(id);
      await client.query(
        `INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, created_by, spec)
         VALUES ($1, 1, $2, 'fetch', 'direct', 'user', $3::jsonb)`,
        [id, i % 2 === 0 ? ownerId : memberId, JSON.stringify({ kind: 'zz_test', url_template: 'https://fixtures.example.test/{page}' })],
      );
      if (i === 0) {
        await client.query("INSERT INTO schedules (api_id, owner_id, cron, timezone) VALUES ($1, $2, '0 6 * * *', 'Europe/Paris')", [id, ownerId]);
      }
    }

    const runIds: string[] = [];
    const [firstApi] = apiIds.healthy;
    for (let n = 0; n < 10; n += 1) {
      const failure = n === 8 ? 'extraction' : n === 9 ? 'network' : null;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO runs (api_id, owner_id, api_owner_id, strategy_version, trigger, state, outcome, items, duration_ms, failure_class, error_detail, finished_at)
         VALUES ($1, $2, $2, 1, 'ui', $5, $6, $3, $4, $7, $8, now()) RETURNING id`,
        [
          firstApi,
          ownerId,
          n + 1,
          100 + n,
          failure ? 'failed' : 'succeeded',
          failure ? 'failed' : 'clean',
          failure,
          failure ? 'zz_test_detail_libre_à_ne_pas_exporter' : null,
        ],
      );
      runIds.push(rows[0]!.id);
    }
    const dataset = await client.query<{ id: string }>(
      'INSERT INTO datasets (api_id, owner_id, run_id, item_count, bytes) VALUES ($1, $2, $3, 5, 50) RETURNING id',
      [firstApi, ownerId, runIds[0]],
    );
    for (let seq = 1; seq <= 5; seq += 1) {
      await client.query(
        'INSERT INTO dataset_items (dataset_id, seq, run_id, owner_id, item, size_bytes) VALUES ($1, $2, $3, $4, $5::jsonb, 10)',
        [dataset.rows[0]!.id, seq, runIds[0], ownerId, JSON.stringify({ n: seq })],
      );
    }
    // Dataset épinglé (aucun item) : exerce le chemin de données de la migration d'épinglage (UPDATE ... WHERE pinned).
    const reasonColumns = await client.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'datasets' AND column_name = 'pinned_reason'");
    const backfilledByMigration = reasonColumns.rowCount === 0;
    const reason = 'zz_test raison d\'épinglage';
    const pinnedDataset = backfilledByMigration
      ? await client.query<{ id: string }>(
          'INSERT INTO datasets (api_id, owner_id, run_id, pinned) VALUES ($1, $2, $3, true) RETURNING id',
          [firstApi, ownerId, runIds[1]],
        )
      : await client.query<{ id: string }>(
          "INSERT INTO datasets (api_id, owner_id, run_id, pinned, pinned_reason, pinned_until) VALUES ($1, $2, $3, true, $4, now() + interval '30 days') RETURNING id",
          [firstApi, ownerId, runIds[1], reason],
        );
    return { ownerId, memberId, apiIds, runIds, secrets, pinned: { datasetId: pinnedDataset.rows[0]!.id, backfilledByMigration, reason } };
  } finally {
    await client.end();
  }
}
