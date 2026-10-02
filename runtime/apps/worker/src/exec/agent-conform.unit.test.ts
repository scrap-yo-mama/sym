// SPDX-License-Identifier: AGPL-3.0-only
// Sortie d'un agent (E4-E6) contre `output_schema` (tâche 2.3, D-49) : en politique `quarantine` (runs), chaque
// enregistrement est rendu à l'exécuteur, qui le trie (Ajv) ; un non-objet est un item non conforme comme un autre (raison
// `type`), jamais la casse du run entier. En `strict` (enquête), le moindre item non conforme fait échouer l'essai.
import { partitionItems } from '@runtime/core';
import { describe, expect, test } from 'vitest';
import { conformRecords } from './agent-executors.js';

const SCHEMA = { type: 'object', required: ['title'], properties: { title: { type: 'string' } }, additionalProperties: false };

describe('conformRecords (E4-E6)', () => {
  test('quarantine : une chaîne, un tableau ou null parmi des items conformes est écarté (raison `type`), le reste est livrable', () => {
    const out = conformRecords([{ title: 'a' }, 'zz_test_texte', ['x'], null, { title: 'b' }], SCHEMA, 1, 'quarantine');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.records).toHaveLength(5);
    const { conform, rejected } = partitionItems(SCHEMA, out.records);
    expect(conform).toEqual([{ title: 'a' }, { title: 'b' }]);
    expect(rejected.map((r) => r.issues[0]?.keyword)).toEqual(['type', 'type', 'type']);
  });

  test('quarantine : aucun item conforme → rendu à l’exécuteur, dont le verdict sur le run casse (0 conforme)', () => {
    const out = conformRecords(['a', { title: 1 }], SCHEMA, 1, 'quarantine');
    expect(out.ok).toBe(true);
  });

  test('aucun enregistrement : `extraction` (`no_records`) dans les deux politiques', () => {
    expect(conformRecords([], SCHEMA, 1, 'quarantine')).toMatchObject({ ok: false, failure: { failure_class: 'extraction', detail: 'no_records' } });
    expect(conformRecords([], SCHEMA, 1)).toMatchObject({ ok: false, failure: { detail: 'no_records' } });
  });

  test('strict (enquête) : un non-objet ou un item non conforme fait échouer l’essai (`schema_mismatch`)', () => {
    expect(conformRecords([{ title: 'a' }, 'b'], SCHEMA, 1)).toMatchObject({ ok: false, failure: { detail: 'schema_mismatch' } });
    expect(conformRecords([{ title: 'a' }], SCHEMA, 1)).toMatchObject({ ok: true, records: [{ title: 'a' }] });
  });
});
