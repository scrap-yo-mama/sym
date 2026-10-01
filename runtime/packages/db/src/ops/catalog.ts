// SPDX-License-Identifier: AGPL-3.0-only
// `runtime export-catalog` (14 § 8) : API, schémas, stratégies et planifications en JSON, SANS secret ni cookie (INV8).
// Liste blanche de colonnes : aucune colonne chiffrée, aucun `secret_id`, aucune donnée de run ni de dataset, aucun
// courriel. L'import repasse par l'enquête (16) : l'état de santé n'est donc exporté qu'à titre indicatif.
import { redact } from '@runtime/core';
import type pg from 'pg';
import { currentSchemaVersion } from '../migrate.js';

export const CATALOG_FORMAT_VERSION = 1;

export type CatalogExport = {
  format: 'runtime-catalog';
  format_version: typeof CATALOG_FORMAT_VERSION;
  exported_at: string;
  schema_version: number;
  projects: { id: string; name: string }[];
  apis: Record<string, unknown>[];
};

type Q = Pick<pg.ClientBase, 'query'>;

export async function exportCatalog(db: Q, now: Date = new Date()): Promise<CatalogExport> {
  const { rows: projects } = await db.query<{ id: string; name: string }>('SELECT id, name FROM projects ORDER BY name');
  const { rows: apis } = await db.query<Record<string, unknown> & { id: string }>(
    `SELECT id, slug, project_id, owner_id, visibility, description, input_schema, output_schema, views, requires, requires_session,
            network_policy, access_policy, domain_pacing, purpose, legal_basis, contains_personal_data, allow_write_actions,
            max_cost_usd::text AS max_cost_usd, budget_daily_usd::text AS budget_daily_usd, mcp_exposed, pinned,
            current_strategy_version, status AS status_at_export, created_at
     FROM apis ORDER BY project_id, slug`,
  );
  const { rows: strategies } = await db.query<Record<string, unknown> & { api_id: string }>(
    `SELECT api_id, version, execution, network, spec, script_ref, est_cost_usd::text AS est_cost_usd, created_by, parent_version, patch, created_at
     FROM strategy_versions ORDER BY api_id, version`,
  );
  const { rows: schedules } = await db.query<Record<string, unknown> & { api_id: string }>(
    'SELECT api_id, cron, timezone, input, rules, overlap, on_missed, enabled, created_at FROM schedules ORDER BY api_id, created_at, id',
  );
  const byApi = <T extends { api_id: string }>(rows: T[]) => {
    const map = new Map<string, Omit<T, 'api_id'>[]>();
    for (const { api_id, ...rest } of rows) map.set(api_id, [...(map.get(api_id) ?? []), rest]);
    return map;
  };
  const strategyMap = byApi(strategies);
  const scheduleMap = byApi(schedules);
  const out: CatalogExport = {
    format: 'runtime-catalog',
    format_version: CATALOG_FORMAT_VERSION,
    exported_at: now.toISOString(),
    schema_version: await currentSchemaVersion(db),
    projects,
    apis: apis.map(({ id, ...api }) => ({
      ...api,
      strategy_versions: strategyMap.get(id) ?? [],
      schedules: scheduleMap.get(id) ?? [],
    })),
  };
  return redact(out);
}
