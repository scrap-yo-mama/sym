// SPDX-License-Identifier: AGPL-3.0-only
// Les énumérations TS de @runtime/core et les CHECK SQL de la base migrée sont identiques (04b § 1).
import {
  API_STATUSES,
  ATTEMPT_RESULTS,
  EXECUTIONS,
  FAILURE_CLASSES,
  INVESTIGATION_PHASES,
  LLM_FAILURE_CLASS_PATTERN,
  NETWORKS,
  RUN_KINDS,
  RUN_OUTCOMES,
  RUN_STATES,
  RUN_TRIGGERS,
  STRATEGY_CREATORS,
  VISIBILITIES,
} from '@runtime/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../tests/helpers/pg.js';
import { migrateUp } from './migrate.js';

let tdb: TestDatabase;
let client: pg.Client;

beforeAll(async () => {
  tdb = await createTestDatabase('enums');
  await migrateUp({ connectionString: tdb.url });
  client = new pg.Client({ connectionString: tdb.url });
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await tdb.drop();
});

/**
 * Valeurs littérales citées dans le CHECK de `table.column` (`column IN ('a', 'b')` ou `= ANY (ARRAY[...])`). Seul le CHECK
 * d'énumération est retenu : celui qui COMMENCE par `column = ANY` ; un CHECK croisé qui cite la colonne plus loin (ex.
 * `runs_paused_state` de 0017 : `paused_at IS NULL OR state = ANY (...)`) n'en est pas un.
 */
async function checkValues(table: string, column: string): Promise<string[]> {
  const { rows } = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(k.oid) AS def
       FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
      WHERE c.relname = $1 AND k.contype = 'c' AND pg_get_constraintdef(k.oid) ~ ('^CHECK \\(\\(*' || $2 || ' = ANY')`,
    [table, column],
  );
  expect(rows, `CHECK de ${table}.${column}`).toHaveLength(1);
  const def = (rows[0] as { def: string }).def;
  // Les littéraux sont retirés du motif `llm_*` (regex `~`) : on ne garde que la partie avant.
  const listPart = def.split(/\)\s*OR\s*\(/)[0] as string;
  return [...listPart.matchAll(/'([^']+)'::text/g)].map((m) => m[1] as string);
}

const sorted = (xs: readonly string[]) => [...xs].sort();

describe('énumérations TS = CHECK SQL', () => {
  test.each([
    ['apis', 'status', API_STATUSES],
    ['apis', 'investigation_phase', INVESTIGATION_PHASES],
    ['apis', 'visibility', VISIBILITIES],
    ['strategy_versions', 'execution', EXECUTIONS],
    ['strategy_versions', 'network', NETWORKS],
    ['strategy_versions', 'created_by', STRATEGY_CREATORS],
    ['runs', 'trigger', RUN_TRIGGERS],
    ['runs', 'state', RUN_STATES],
    ['runs', 'outcome', RUN_OUTCOMES],
    ['runs', 'kind', RUN_KINDS],
    ['run_attempts', 'execution', EXECUTIONS],
    ['run_attempts', 'network', NETWORKS],
  ] as const)('%s.%s', async (table, column, values) => {
    expect(sorted(await checkValues(table, column))).toEqual(sorted(values));
  });

  test('runs.failure_class : liste fermée identique, motif llm_* identique', async () => {
    expect(sorted(await checkValues('runs', 'failure_class'))).toEqual(sorted(FAILURE_CLASSES));
    const { rows } = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
        WHERE c.relname = 'runs' AND k.contype = 'c' AND pg_get_constraintdef(k.oid) LIKE '%failure_class%'`,
    );
    const sqlPattern = /~ '([^']+)'::text/.exec((rows[0] as { def: string }).def)?.[1];
    expect(sqlPattern).toBe(LLM_FAILURE_CLASS_PATTERN.source);
  });

  test('run_attempts.result_class : ok + même liste fermée, même motif llm_*', async () => {
    expect(sorted(await checkValues('run_attempts', 'result_class'))).toEqual(sorted(ATTEMPT_RESULTS));
    const { rows } = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
        WHERE c.relname = 'run_attempts' AND k.contype = 'c' AND pg_get_constraintdef(k.oid) LIKE '%result_class%'`,
    );
    const sqlPattern = /~ '([^']+)'::text/.exec((rows[0] as { def: string }).def)?.[1];
    expect(sqlPattern).toBe(LLM_FAILURE_CLASS_PATTERN.source);
  });
});
