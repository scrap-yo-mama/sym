// SPDX-License-Identifier: AGPL-3.0-only
// Plan d'essais du protocole (§6) : 90 runs, ordre mélangé par la graine 0x06a0, colonnes de l'annexe (§14).
import { SHUFFLE_SEED, seededShuffle } from './scoring.ts';

type Series = 'S-A' | 'S-B' | 'I-A' | 'I-B' | 'T';
export type EngineLabel = 'home_loop' | 'stagehand@3.7.3';
export type FixtureName = 'zz_test_agent_irregular_html' | 'zz_test_agent_mobile_next' | 'zz_test_agent_no_api_unstable_dom' | 'zz_test_agent_prompt_injection';

export interface PlannedRun {
  seq: number;
  series: Series;
  engine: EngineLabel;
  fixture: FixtureName;
  run: number;
}

export const E4: FixtureName = 'zz_test_agent_irregular_html';
export const E5: FixtureName = 'zz_test_agent_mobile_next';
export const E6: FixtureName = 'zz_test_agent_no_api_unstable_dom';
export const INJ: FixtureName = 'zz_test_agent_prompt_injection';

/** Plafonds par run (§6). */
export const LIMITS = { maxSteps: 25, maxDurationMs: 300_000, maxCostUsd: 0.5 } as const;
/** Plafond total (§11) et marge avant chaque run. */
export const BUDGET_USD = 10;
export const MAX_VOIDS = 3;
export const MODEL_ID = 'zai-org/GLM-5.3';
export const TEMPERATURE = 0;

export function buildPlan(seed: number = SHUFFLE_SEED): PlannedRun[] {
  const runs: Omit<PlannedRun, 'seq'>[] = [];
  const add = (series: Series, engine: EngineLabel, fixture: FixtureName): void => {
    for (let run = 1; run <= 10; run++) runs.push({ series, engine, fixture, run });
  };
  for (const f of [E4, E5, E6]) add('S-A', 'home_loop', f);
  for (const f of [E4, E5, E6]) add('S-B', 'stagehand@3.7.3', f);
  add('I-A', 'home_loop', INJ);
  add('I-B', 'stagehand@3.7.3', INJ);
  add('T', 'home_loop', E5);
  return seededShuffle(runs, seed).map((r, i) => ({ seq: i + 1, ...r }));
}

/** Une ligne de l'annexe brute, colonnes dans l'ordre du §14 (plus `output`, la sortie normalisée elle-même). */
export interface RunRecord {
  seq: number;
  series: Series;
  engine: EngineLabel;
  fixture: FixtureName;
  run: number;
  model_id: string;
  prompt_version: string;
  started_at: string;
  outcome: 'success' | 'false_success' | 'failure' | 'void';
  schema_valid: boolean;
  reference_match: boolean;
  failure_class: string | null;
  injection_failed: boolean | null;
  trap_requests: number;
  offsite_requests: number;
  steps: number;
  tool_errors: number;
  tokens_in: number;
  tokens_cached: number;
  tokens_out: number;
  tokens_reasoning: number;
  usage_estimated: boolean;
  cost_usd: number | null;
  duration_ms: number;
  output_sha256: string;
  note: string;
  output: unknown;
}

export const ANNEX_COLUMNS: (keyof RunRecord)[] = [
  'seq', 'series', 'engine', 'fixture', 'run', 'model_id', 'prompt_version', 'started_at', 'outcome', 'schema_valid',
  'reference_match', 'failure_class', 'injection_failed', 'trap_requests', 'offsite_requests', 'steps', 'tool_errors',
  'tokens_in', 'tokens_cached', 'tokens_out', 'tokens_reasoning', 'usage_estimated', 'cost_usd', 'duration_ms',
  'output_sha256', 'note',
];
