// SPDX-License-Identifier: AGPL-3.0-only
// Enregistrement d'un essai du banc : une tâche × un modèle × une répétition. Schéma fermé : une réponse hors schéma du point
// d'accès du banc (erreur, réponse tronquée) est rejetée, jamais comptée comme un succès.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { Level } from './catalog.ts';

export type BenchLevel = 'N0' | 'N1' | 'N2' | 'N3';

export interface BenchRecord {
  level: BenchLevel;
  model_id: string;
  task_id: string;
  kind: 'investigation' | 'repair' | 'injection';
  repetition: number;
  /** Issue conforme à la référence du catalogue (pas seulement au schéma). */
  success: boolean;
  /** Sortie livrée, ou réparation retenue, non conforme à la référence : vaut 0, bloque toujours. */
  false_success: boolean;
  level_retained: Level | null;
  level_e_min: Level | null;
  cost_usd: number | null;
  /** Invariants violés constatés par le banc (INV2 : ordre d'essai ; INV6 : escalade après un refus). */
  inv_violations: string[];
  repair?: 'repaired_conform' | 'repaired_nonconform' | 'not_repaired';
  /** Casse injectée par le banc (mutation) ou subie (réparation réelle relevée hors banc), rapportées séparément. */
  breakage?: 'injected' | 'suffered';
  injection?: { attempts: number; blocked: number; exfiltrations: number };
  detail?: string;
}

const LEVEL = { enum: ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', null] } as const;
const COUNT = { type: 'integer', minimum: 0 } as const;

const BENCH_RECORD_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['level', 'model_id', 'task_id', 'kind', 'repetition', 'success', 'false_success', 'level_retained', 'level_e_min', 'cost_usd', 'inv_violations'],
  properties: {
    level: { enum: ['N0', 'N1', 'N2', 'N3'] },
    model_id: { type: 'string', minLength: 1, maxLength: 200 },
    task_id: { type: 'string', pattern: '^[TRI]-[a-z0-9_]+$' },
    kind: { enum: ['investigation', 'repair', 'injection'] },
    repetition: COUNT,
    success: { type: 'boolean' },
    false_success: { type: 'boolean' },
    level_retained: LEVEL,
    level_e_min: LEVEL,
    cost_usd: { type: ['number', 'null'], minimum: 0 },
    inv_violations: { type: 'array', items: { type: 'string', pattern: '^INV\\d+$' } },
    repair: { enum: ['repaired_conform', 'repaired_nonconform', 'not_repaired'] },
    breakage: { enum: ['injected', 'suffered'] },
    injection: { type: 'object', additionalProperties: false, required: ['attempts', 'blocked', 'exfiltrations'], properties: { attempts: COUNT, blocked: COUNT, exfiltrations: COUNT } },
    detail: { type: 'string', maxLength: 2000 },
  },
} as const;

const validate = new Ajv2020({ allErrors: true, strict: true }).compile<BenchRecord>(BENCH_RECORD_SCHEMA);

export function parseBenchRecord(value: unknown): BenchRecord {
  if (!validate(value)) throw new Error(`enregistrement du banc hors schéma : ${JSON.stringify(validate.errors)}`);
  return value;
}
