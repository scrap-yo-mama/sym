// SPDX-License-Identifier: AGPL-3.0-only
// Export et import d'une API (tâche 3.12, 16 § 6), sous l'identité du propriétaire (`withActor`, RLS, INV12).
//
// Export : la définition de l'API, sa stratégie courante si elle est exportable (déclarative, sans session, tunnel ni
// code), l'historique de ses versions (métadonnées), les planifications DU PROPRIÉTAIRE et ses cibles d'alerte en
// référence. Lecture par colonnes nommées : jamais `requires`, `requires_session`, une ligne `site_sessions`, `secrets`,
// une URL ou un secret de webhook, un identifiant de proxy, ni une donnée de run (INV5, INV8, `assert_export_no_secret`).
// Le tunnel (navigateur, session et IP de l'utilisateur) n'apparaît nulle part : ni dans la politique réseau, ni dans la
// stratégie, ni dans l'historique (une version en tunnel dirait que l'API porte une session).
//
// Import : nouvelle API privée du propriétaire en `enquete` (aucun nouvel état, INV3), sans session ; l'enquête entre au
// stade `access_check` avec le schéma de sortie du fichier validé et la stratégie importée à essayer (`testing`). Les
// planifications sont recréées DÉSACTIVÉES ; aucune cible d'alerte n'est créée (références à configurer).
import {
  API_EXPORT_FORMAT,
  API_EXPORT_FORMAT_VERSION,
  API_EXPORT_MIN_RUNTIME_VERSION,
  exportableStrategy,
  PORTABLE_NETWORKS,
  portableNetworkAllow,
  sealExport,
  type ApiExport,
  type ApiExportSchedule,
  type JobQueue,
  type RunTrigger,
} from '@runtime/core';
import type pg from 'pg';
import { schemaColumns, startInvestigation } from './investigations.js';
import { validateSchedule } from './schedules.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export class PortabilityError extends Error {
  readonly code: 'export_unavailable' | 'invalid_schedule';
  constructor(code: PortabilityError['code'], message: string) {
    super(message);
    this.name = 'PortabilityError';
    this.code = code;
  }
}


/**
 * Export scellé de l'API `apiId` de `ownerId` (null si elle n'est pas la sienne). Lève `export_unavailable` si l'API n'a
 * pas de demande d'enquête connue (URL de la page) : son import ne pourrait pas repasser par l'étape 0.
 */
export async function exportApi(db: Queryable, input: { apiId: string; ownerId: string; exportedAt: Date }): Promise<ApiExport | null> {
  const { rows } = await db.query<{
    slug: string;
    description: string;
    source_url: string | null;
    request_description: string | null;
    input_schema: Record<string, unknown>;
    output_schema: Record<string, unknown>;
    output_columns: string[] | null;
    views: Record<string, unknown>;
    purpose: string;
    legal_basis: string | null;
    contains_personal_data: boolean;
    max_cost_usd: string | null;
    budget_daily_usd: string;
    network_policy: Record<string, unknown>;
    current_strategy_version: number | null;
  }>(
    `SELECT slug, description, investigation -> 'request' ->> 'url' AS source_url, investigation -> 'request' ->> 'description' AS request_description, input_schema, output_schema, output_columns, views, purpose,
            legal_basis, contains_personal_data, max_cost_usd, budget_daily_usd, network_policy, current_strategy_version
     FROM apis WHERE id = $1 AND owner_id = $2`,
    [input.apiId, input.ownerId],
  );
  const api = rows[0];
  if (api === undefined) return null;
  if (api.source_url === null || !URL.canParse(api.source_url)) throw new PortabilityError('export_unavailable', 'API sans demande d’enquête connue : rien à rejouer à l’import');

  const versions = (
    await db.query<{ version: number; execution: string; network: string; created_by: string; created_at: Date; spec: unknown; script_ref: string | null; est_cost_usd: string | null }>(
      'SELECT version, execution, network, created_by, created_at, spec, script_ref, est_cost_usd FROM strategy_versions WHERE api_id = $1 ORDER BY version',
      [input.apiId],
    )
  ).rows;
  const current = versions.find((v) => v.version === api.current_strategy_version);
  const schedules = (
    await db.query<{ cron: string; timezone: string; input: Record<string, unknown> | null; rules: Record<string, unknown> | null; overlap: ApiExportSchedule['overlap']; on_missed: ApiExportSchedule['missed']; enabled: boolean }>(
      'SELECT cron, timezone, input, rules, overlap, on_missed, enabled FROM schedules WHERE api_id = $1 AND owner_id = $2 ORDER BY created_at, id',
      [input.apiId, input.ownerId],
    )
  ).rows;
  // Cibles d'alerte : seulement les ÉVÉNEMENTS, sous une référence ; ni l'URL (elle peut porter un jeton) ni le secret.
  const hooks = (await db.query<{ events: string[] }>('SELECT events FROM webhook_subscriptions WHERE api_id = $1 AND owner_id = $2 ORDER BY created_at, id', [input.apiId, input.ownerId])).rows;
  const allow = portableNetworkAllow(Array.isArray(api.network_policy['allow']) ? (api.network_policy['allow'] as unknown[]) : undefined);
  const columns = (api.output_columns ?? []).length > 0 ? api.output_columns! : schemaColumns(api.output_schema);
  const viewColumns = Array.isArray(api.views['columns']) ? (api.views['columns'] as unknown[]).filter((c): c is string => typeof c === 'string') : undefined;

  return sealExport({
    format: API_EXPORT_FORMAT,
    format_version: API_EXPORT_FORMAT_VERSION,
    min_runtime_version: API_EXPORT_MIN_RUNTIME_VERSION,
    exported_at: input.exportedAt.toISOString(),
    api: {
      slug: api.slug,
      // Description de l'API, à défaut celle de la demande d'enquête (une API créée hors console peut ne pas en avoir).
      description: api.description.trim() !== '' ? api.description : (api.request_description ?? '').trim(),
      source_url: api.source_url,
      input_schema: api.input_schema,
      output_schema: api.output_schema,
      output_columns: columns,
      views: viewColumns === undefined ? {} : { columns: viewColumns },
      purpose: api.purpose === '' ? null : api.purpose,
      legal_basis: api.legal_basis,
      contains_personal_data: api.contains_personal_data,
      // D-123 : sans plafond par run (NULL), le champ est omis (un import plus ancien le lit comme absent).
      ...(api.max_cost_usd === null ? {} : { max_cost_usd: Number(api.max_cost_usd) }),
      budget_daily_usd: Number(api.budget_daily_usd),
      network_policy: { allow },
      alert_targets: hooks.map((h, i) => ({ ref: `$ALERT_WEBHOOK_${i + 1}`, events: [...h.events].sort() })),
    },
    strategy: current === undefined ? null : exportableStrategy(current),
    history: versions.filter((v) => (PORTABLE_NETWORKS as readonly string[]).includes(v.network)).map((v) => ({ version: v.version, execution: v.execution, network: v.network, created_by: v.created_by, created_at: v.created_at.toISOString() })),
    schedules: schedules.map((s) => ({
      cron: s.cron,
      timezone: s.timezone,
      input: s.input ?? {},
      // `alert_on` absent (null) : la règle par défaut s'applique ; il n'est pas exporté.
      rules: Object.fromEntries(Object.entries(s.rules ?? {}).filter(([k, v]) => !(k === 'alert_on' && v === null))),
      overlap: s.overlap,
      missed: s.on_missed,
      enabled: s.enabled,
    })),
  });
}

/**
 * Importe un export DÉJÀ relu (`parseApiExport`) pour `ownerId`, dans la transaction `tx` (`withActor` du propriétaire) :
 * API privée en `enquete`, sans session, enquête en file au stade `access_check`, planifications désactivées. `slug` est
 * choisi par l'appelant (libre) ; `networkPolicy` est la politique déjà contrôlée (niveaux connus, proxys de l'admin).
 */
export async function importApi(
  tx: Queryable,
  queue: JobQueue,
  input: { ownerId: string; slug: string; trigger: RunTrigger; export: ApiExport; networkPolicy: Record<string, unknown> },
): Promise<{ apiId: string; runId: string }> {
  const doc = input.export;
  const api = doc.api;
  // Planifications validées AVANT toute écriture (cron, fuseau, règles fermées : 2.5).
  const schedules = doc.schedules.map((s) => {
    const checked = validateSchedule(queue, { cron: s.cron, timezone: s.timezone, input: s.input, rules: s.rules, overlap: s.overlap, onMissed: s.missed, enabled: false });
    if (!checked.ok) throw new PortabilityError('invalid_schedule', checked.errors.join(' ; '));
    return checked.schedule;
  });
  const viewColumns = api.views?.columns;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO apis (slug, owner_id, visibility, description, status, network_policy, views, purpose, legal_basis, contains_personal_data,
                       max_cost_usd, budget_daily_usd)
     VALUES ($1, $2, 'private', $3, 'enquete', $4::jsonb, $5::jsonb, $6, $7, $8, $9::numeric, coalesce($10::numeric, 5)) RETURNING id`,
    [
      input.slug,
      input.ownerId,
      api.description.trim(),
      JSON.stringify(input.networkPolicy),
      JSON.stringify(viewColumns === undefined ? {} : { columns: viewColumns }),
      api.purpose ?? '',
      api.legal_basis ?? null,
      api.contains_personal_data === true,
      api.max_cost_usd ?? null,
      api.budget_daily_usd ?? null,
    ],
  );
  const apiId = rows[0]!.id;
  const strategy = doc.strategy;
  const { runId } = await startInvestigation(tx, queue, {
    apiId,
    ownerId: input.ownerId,
    trigger: input.trigger,
    request: { url: api.source_url, description: api.description, auto_validate: false },
    imported: {
      outputSchema: api.output_schema,
      ...(api.output_columns === undefined ? {} : { outputColumns: api.output_columns }),
      strategy: strategy === null ? null : { execution: strategy.execution, network: strategy.network, spec: strategy.spec, input_schema: api.input_schema },
    },
  });
  for (const s of schedules) {
    await tx.query(
      `INSERT INTO schedules (api_id, owner_id, cron, timezone, input, rules, overlap, on_missed, enabled)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, false)`,
      [apiId, input.ownerId, s.cron, s.timezone, JSON.stringify(s.input), JSON.stringify(s.rules), s.overlap, s.onMissed],
    );
  }
  return { apiId, runId };
}
