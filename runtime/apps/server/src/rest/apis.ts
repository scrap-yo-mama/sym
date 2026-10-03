// SPDX-License-Identifier: AGPL-3.0-only
// API du catalogue vues par l'API REST (tâche 3.1, 04b § 1, 05 § 4.1-4.2, 06 § 2) : lecture par slug sous RLS, lignes du
// catalogue, fiche, création (slug, politique réseau, enquête dans la même transaction).
//
// Visibilité (13 § 2-3, INV12) : un membre voit ses API et celles en `visibility: instance` sans session (RLS
// `instance_read`). L'état d'enquête (`apis.investigation`) n'entre dans AUCUNE vue ; la phase seule est servie. L'admin
// lit les métadonnées d'une API à session d'autrui (`metadata_only`), jamais ses schémas, son échantillon ni sa stratégie.
import { randomBytes } from 'node:crypto';
import type { PersistencePolicy } from '@runtime/core';
import { parseNetworkPolicy, NetworkConfigError } from '@runtime/core/net';
import { instructedStateIn, persistenceStateOf, withActor } from '@runtime/db';
import type pg from 'pg';
import type { ServerContext } from '../context.js';
import type { Actor } from '../routes/guard.js';
import { iso, reasonMessage, usd, usdOrNull } from './shared.js';
import { listRunRows, runSummary } from './runs.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export type ApiRow = {
  id: string;
  slug: string;
  owner_id: string;
  project_id: string;
  visibility: 'private' | 'instance';
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  views: Record<string, unknown>;
  status: string;
  investigation_phase: string | null;
  status_reason: string | null;
  stale: boolean;
  clean_streak: number;
  last_signal_at: Date | null;
  current_strategy_version: number | null;
  requires: Record<string, unknown>;
  requires_session: boolean;
  network_policy: Record<string, unknown>;
  access_policy: Record<string, unknown>;
  domain_pacing: Record<string, unknown>;
  purpose: string;
  legal_basis: string | null;
  contains_personal_data: boolean;
  allow_write_actions: boolean;
  max_cost_usd: string;
  budget_daily_usd: string;
  mcp_exposed: boolean;
  pinned: boolean;
  created_at: Date;
  /** `created_at` au texte exact de PostgreSQL (curseur, microsecondes comprises). */
  created_text: string;
  updated_at: Date;
  /** Stratégie courante (jointure). */
  execution: string | null;
  network: string | null;
  /** Agrégats des runs de l'ACTEUR sur cette API (30 jours). */
  avg_cost_usd: string | null;
  last_run_at: Date | null;
  runs_30d: number;
  succeeded_30d: number;
  /** URL de départ de l'enquête (`investigation.request.url`), seulement pour en tirer le domaine ; null sans enquête. */
  start_url: string | null;
};

/** Colonnes servies (jamais `investigation` entier, `repair_lease_*`, `warning_alerted_at`) ; de l'enquête, seule l'URL de départ (domaine). */
const API_COLUMNS = `a.id, a.slug, a.owner_id, a.project_id, a.visibility, a.description, a.input_schema, a.output_schema, a.views, a.status,
  a.investigation_phase, a.status_reason, a.stale, a.clean_streak, a.last_signal_at, a.current_strategy_version, a.requires,
  a.requires_session, a.network_policy, a.access_policy, a.domain_pacing, a.purpose, a.legal_basis, a.contains_personal_data,
  a.allow_write_actions, a.max_cost_usd, a.budget_daily_usd, a.mcp_exposed, a.pinned, a.created_at, a.created_at::text AS created_text, a.updated_at,
  a.investigation #>> '{request,url}' AS start_url,
  sv.execution, sv.network, st.avg_cost_usd, st.last_run_at, coalesce(st.runs_30d, 0)::int AS runs_30d, coalesce(st.succeeded_30d, 0)::int AS succeeded_30d`;

/** Jointures : stratégie courante et agrégats des runs visibles (sous RLS : ceux de l'acteur). */
const API_FROM = `apis a
  LEFT JOIN strategy_versions sv ON sv.api_id = a.id AND sv.version = a.current_strategy_version
  LEFT JOIN LATERAL (
    SELECT avg(r.cost_llm_usd + r.cost_proxy_usd) FILTER (WHERE r.state = 'succeeded' AND r.kind = 'run') AS avg_cost_usd,
           max(r.created_at) AS last_run_at,
           count(*) FILTER (WHERE r.state IN ('succeeded', 'failed') AND r.kind = 'run') AS runs_30d,
           count(*) FILTER (WHERE r.state = 'succeeded' AND r.kind = 'run') AS succeeded_30d
    FROM runs r WHERE r.api_id = a.id AND r.created_at > now() - interval '30 days'
  ) st ON true`;

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** API visible de l'acteur (RLS : siennes + instance sans session) ; null si inexistante ou invisible. */
export async function readApiBySlug(db: Queryable, slug: string): Promise<ApiRow | null> {
  if (!SLUG.test(slug)) return null;
  const { rows } = await db.query<ApiRow>(`SELECT ${API_COLUMNS} FROM ${API_FROM} WHERE a.slug = $1`, [slug]);
  return rows[0] ?? null;
}

export async function readApiById(db: Queryable, id: string): Promise<ApiRow | null> {
  const { rows } = await db.query<ApiRow>(`SELECT ${API_COLUMNS} FROM ${API_FROM} WHERE a.id = $1`, [id]);
  return rows[0] ?? null;
}

export async function listApiRows(db: Queryable, where: string, params: unknown[], limit: number): Promise<ApiRow[]> {
  const { rows } = await db.query<ApiRow>(`SELECT ${API_COLUMNS} FROM ${API_FROM} WHERE ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ${limit}`, params);
  return rows;
}

/** Dépendances (06 § 2) : session sur tel domaine, tunnel (« ordinateur requis ») si l'API ou sa stratégie courante l'exige. */
const requiresOf = (r: Pick<ApiRow, 'requires' | 'network'>) => ({
  session_domain: typeof r.requires['session_domain'] === 'string' ? r.requires['session_domain'] : null,
  tunnel: r.requires['tunnel'] === true || r.network === 'tunnel',
});

/** Domaine d'une URL de départ : son hôte, en minuscules (WHATWG), sans port ni chemin ; null si l'URL est absente ou illisible. */
function domainOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Ligne du catalogue (`ApiSummary`). `accessSignal` : pastille Accès du dernier rapport (propriétaire seulement). */
export function apiSummary(r: ApiRow, accessSignal: string | null = null) {
  return {
    id: r.id,
    slug: r.slug,
    description: r.description,
    // « Nom et domaine » (20 § 5.2) : le domaine de la page enquêtée (`assert_catalog_summary_domain`).
    domain: domainOf(r.start_url),
    status: r.status,
    status_reason: reasonMessage(r.status_reason),
    stale: r.stale,
    execution: r.execution,
    network: r.network,
    requires: requiresOf(r),
    avg_cost_usd: usdOrNull(r.avg_cost_usd),
    avg_cost_estimated: false,
    last_run_at: iso(r.last_run_at),
    success_rate_30d: r.runs_30d > 0 ? Math.round((r.succeeded_30d / r.runs_30d) * 1000) / 1000 : null,
    access_signal: accessSignal,
    visibility: r.visibility,
    owner_id: r.owner_id,
    pinned: r.pinned,
    mcp_exposed: r.mcp_exposed,
  };
}

type AccessView = { id: string; checked_at: string; signal: 'allowed' | 'review' | 'disallowed'; [key: string]: unknown };

/** Dernier rapport d'accès d'une API (événement `access_report` d'une enquête, 17 § 2) : vue du rapport, sous RLS. */
export async function latestAccessReport(db: Queryable, apiId: string): Promise<AccessView | null> {
  const { rows } = await db.query<{ view: AccessView | null }>(
    `SELECT e.payload -> 'view' AS view FROM investigation_events e JOIN runs r ON r.id = e.run_id
     WHERE r.api_id = $1 AND e.kind = 'access_report' ORDER BY e.at DESC, e.seq DESC LIMIT 1`,
    [apiId],
  );
  const view = rows[0]?.view;
  return view && typeof view === 'object' && typeof view.id === 'string' ? view : null;
}

/** Dernier schéma proposé et son échantillon (événement `schema.proposed` réussi), sous RLS : propriétaire seulement. */
export async function latestProposal(db: Queryable, apiId: string): Promise<{ output_schema: Record<string, unknown> | null; sample: Record<string, unknown>[] }> {
  const { rows } = await db.query<{ payload: { ok?: boolean; output_schema?: unknown; sample?: unknown } }>(
    `SELECT e.payload FROM investigation_events e JOIN runs r ON r.id = e.run_id
     WHERE r.api_id = $1 AND e.kind = 'schema.proposed' ORDER BY e.at DESC, e.seq DESC LIMIT 1`,
    [apiId],
  );
  const p = rows[0]?.payload;
  if (!p || p.ok !== true) return { output_schema: null, sample: [] };
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  return { output_schema: isRecord(p.output_schema) ? p.output_schema : null, sample: Array.isArray(p.sample) ? p.sample.filter(isRecord) : [] };
}

type VersionRow = { version: number; execution: string; network: string; est_cost_usd: string | null; created_by: string; parent_version: number | null; created_at: Date };

export const versionSummary = (v: VersionRow) => ({
  version: v.version,
  execution: v.execution,
  network: v.network,
  est_cost_usd: usdOrNull(v.est_cost_usd),
  created_by: v.created_by,
  parent_version: v.parent_version,
  created_at: v.created_at.toISOString(),
  validated_samples: null,
  run_id: null,
});

/**
 * Fiche d'une API visible de l'acteur (`ApiDetail`). Le rapport d'accès et les runs récents sont ceux de l'acteur ; la
 * politique du propriétaire (projet, finalité, base légale, budgets, rythme, proxys) n'est servie qu'à lui (constat B5).
 */
export async function apiDetail(db: Queryable, actor: Actor, r: ApiRow, persistencePolicy: PersistencePolicy) {
  const current =
    r.current_strategy_version === null
      ? null
      : ((
          await db.query<VersionRow>(
            'SELECT version, execution, network, est_cost_usd, created_by, parent_version, created_at FROM strategy_versions WHERE api_id = $1 AND version = $2',
            [r.id, r.current_strategy_version],
          )
        ).rows[0] ?? null);
  const access = await latestAccessReport(db, r.id);
  const recent = await listRunRows(db, 'r.api_id = $1 AND r.owner_id = $2', [r.id, actor.userId], 10);
  const costs = await db.query<{ c: string | null }>(
    `SELECT (r.cost_llm_usd + r.cost_proxy_usd)::text AS c FROM runs r
     WHERE r.api_id = $1 AND r.owner_id = $2 AND r.state = 'succeeded' AND r.kind = 'run' AND r.cost_llm_usd IS NOT NULL ORDER BY r.created_at DESC LIMIT 10`,
    [r.id, actor.userId],
  );
  // Mode « agent instruit » (2.13, 19 § 4) : propriétaire seul ; étapes instruites de la version courante (intentions NON
  // FIABLES, affichées en texte brut), empreinte à confirmer, coût estimé d'un run instruit.
  const instructed = r.owner_id === actor.userId ? await instructedStateIn(db, r.id) : null;
  const values = costs.rows.map((c) => usd(c.c)).sort((a, b) => a - b);
  const median = values.length === 0 ? null : values.length % 2 === 1 ? values[(values.length - 1) / 2]! : Math.round(((values[values.length / 2 - 1]! + values[values.length / 2]!) / 2) * 1e6) / 1e6;
  const policy = r.network_policy;
  const allow = Array.isArray(policy['allow']) ? policy['allow'] : ['direct'];
  // Membre qui lit l'API `instance` d'autrui : de quoi la lancer (schémas, statut, exécution, réseau autorisé, coût
  // estimé), jamais la politique du propriétaire (projet, finalité, base légale, budgets, rythme par domaine, proxys).
  const owner = r.owner_id === actor.userId;
  const ownerPolicy = owner
    ? {
        project_id: r.project_id,
        purpose: r.purpose === '' ? null : r.purpose,
        legal_basis: r.legal_basis,
        max_cost_usd: usd(r.max_cost_usd),
        budget_daily_usd: usd(r.budget_daily_usd),
        domain_pacing: r.domain_pacing,
        // Mode « SYM ne lâche pas » (2.16, D-49) : interrupteur, plafond effectif, prochain essai et dépense du cycle.
        persistence: await persistenceStateOf(db, { apiId: r.id, userId: actor.userId }, persistencePolicy),
      }
    : {};
  return {
    ...apiSummary(r, access?.signal ?? null),
    metadata_only: false,
    investigation_phase: r.investigation_phase,
    input_schema: r.input_schema,
    output_schema: r.output_schema,
    views: r.views,
    clean_streak: r.clean_streak,
    last_signal_at: iso(r.last_signal_at),
    current_strategy_version: r.current_strategy_version,
    current_strategy: current === null ? null : versionSummary(current),
    network_policy: owner
      ? { allow, ...('proxy_ids' in policy ? { proxy_ids: policy['proxy_ids'] } : {}), ...('res_proxy_params' in policy ? { res_proxy_params: policy['res_proxy_params'] } : {}), ...('dc_proxy_params' in policy ? { dc_proxy_params: policy['dc_proxy_params'] } : {}) }
      : { allow },
    access_policy: { report_id: access?.id ?? null },
    access_report: access,
    ...ownerPolicy,
    ...(r.owner_id === actor.userId
      ? {
          instructed_mode: instructed?.instructed_mode ?? false,
          instructed:
            instructed === null || instructed.steps === null || instructed.steps.length === 0 || instructed.sha256 === null
              ? null
              : {
                  version: instructed.version,
                  compilable: instructed.compilable,
                  steps: instructed.steps,
                  sha256: instructed.sha256,
                  confirmed_by: instructed.confirmed_by,
                  confirmed_at: instructed.confirmed_at,
                  estimated_run_usd: instructed.estimated_run_usd,
                },
        }
      : {}),
    contains_personal_data: r.contains_personal_data,
    allow_write_actions: r.allow_write_actions,
    cost_estimate: { median_usd: median, sample_size: values.length },
    session_owner: null,
    recent_runs: recent.map(runSummary),
    retention_days: null,
    created_at: r.created_at.toISOString(),
  };
}

/**
 * Métadonnées d'une API à session d'autrui pour l'admin et l'owner (13 § 2 : `apis:read` M ; 06 § 2) : statut, raison,
 * visibilité, propriétaire. Ni description, ni schémas, ni stratégie, ni échantillon. null sinon (404 uniforme).
 */
export async function apiMetadataForAdmin(ctx: ServerContext, actor: Actor, slug: string) {
  if ((actor.role !== 'admin' && actor.role !== 'owner') || !SLUG.test(slug)) return null;
  const { rows } = await ctx.pool.query<{ id: string; slug: string; owner_id: string; status: string; status_reason: string | null; stale: boolean; investigation_phase: string | null; requires: Record<string, unknown>; created_at: Date; mcp_exposed: boolean; pinned: boolean }>(
    `SELECT id, slug, owner_id, status, status_reason, stale, investigation_phase, requires, created_at, mcp_exposed, pinned
     FROM apis WHERE slug = $1 AND requires_session AND owner_id <> $2`,
    [slug, actor.userId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    slug: r.slug,
    description: '',
    status: r.status,
    status_reason: reasonMessage(r.status_reason),
    stale: r.stale,
    execution: null,
    network: null,
    requires: { session_domain: typeof r.requires['session_domain'] === 'string' ? r.requires['session_domain'] : null, tunnel: r.requires['tunnel'] === true },
    avg_cost_usd: null,
    visibility: 'private' as const,
    owner_id: r.owner_id,
    pinned: r.pinned,
    mcp_exposed: r.mcp_exposed,
    metadata_only: true,
    investigation_phase: r.investigation_phase,
    current_strategy_version: null,
    created_at: r.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Création (create_api, 05 § 4.1)
// ---------------------------------------------------------------------------------------------------------------

export class ApiInputError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiInputError';
    this.code = code;
  }
}

/**
 * Politique réseau d'une API (04 § 3.2) : niveaux connus, proxys de l'admin désignés par leur identifiant, `res_proxy` par
 * opt-in explicite. Rendue en JSON (`apis.network_policy`). Aucune URL ni argument de proxy n'est accepté d'un membre.
 */
export async function checkNetworkPolicy(ctx: ServerContext, input: unknown): Promise<Record<string, unknown>> {
  try {
    parseNetworkPolicy(input);
  } catch (error) {
    if (error instanceof NetworkConfigError) throw new ApiInputError('invalid_network_policy', error.message);
    throw error;
  }
  const policy = input as { allow: string[]; proxy_ids?: Record<string, string> };
  const ids = Object.values(policy.proxy_ids ?? {});
  if (ids.length > 0) {
    const { rows } = await ctx.pool.query<{ value: unknown }>("SELECT value FROM settings WHERE key = 'proxies'");
    const known = new Set((Array.isArray(rows[0]?.value) ? (rows[0]!.value as { id?: unknown }[]) : []).map((p) => p.id));
    if (!ids.every((id) => known.has(id))) throw new ApiInputError('invalid_network_policy', 'network_policy.proxy_ids : proxy inconnu');
  }
  return input as Record<string, unknown>;
}

/**
 * Slug lisible tiré de la description (ASCII, tirets) et TOUJOURS suffixé d'un aléa (`base-xxxxxx`), unique ; jamais celui
 * d'une autre API. Le suffixe systématique ne laisse aucun indice (13 § 3) : la réponse a la même forme que la base soit
 * libre ou prise par une API invisible pour l'acteur. L'URL est validée par l'appelant (400 `invalid_request`).
 */
export async function freeSlug(ctx: ServerContext, description: string, url: string): Promise<string> {
  const words = description
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 2)
    .slice(0, 4);
  let base = words.join('-').slice(0, 40).replace(/-+$/, '');
  if (base === '') base = (URL.parse(url)?.hostname ?? '').replace(/^www\./, '').split('.')[0]?.replace(/[^a-z0-9-]/g, '') ?? '';
  if (!/^[a-z0-9]/.test(base)) base = `api-${base}`.replace(/-+$/, '');
  // Identité système : un slug pris par une API invisible de l'acteur est évité sans révéler qu'elle existe.
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = `${base.slice(0, 50).replace(/-+$/, '')}-${randomBytes(3).toString('hex')}`;
    const { rowCount } = await ctx.pool.query('SELECT 1 FROM apis WHERE slug = $1', [candidate]);
    if (!rowCount) return candidate;
  }
  throw new Error('aucun slug libre');
}

/**
 * Insère l'API (sous l'acteur, propriétaire) ; l'enquête est lancée par l'appelant dans la même transaction. Non épinglée
 * pour le MCP (`mcp_exposed` faux, 05 § 1.1 « épinglées dans la console ») : en mode `pinned`, son outil `api_<slug>`
 * n'apparaît qu'une fois épinglée par son propriétaire (console, ou PATCH /api/apis/{slug}) ; le défaut de colonne de 0001
 * (vrai) ne vaut que pour les insertions hors de cette route.
 */
export async function insertApi(
  db: Queryable,
  actor: Actor,
  input: { slug: string; description: string; visibility: 'private' | 'instance'; networkPolicy: Record<string, unknown> | null },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO apis (slug, owner_id, visibility, description, status, network_policy, mcp_exposed)
     VALUES ($1, $2, $3, $4, 'enquete', coalesce($5::jsonb, '{"allow": ["direct"]}'::jsonb), false) RETURNING id`,
    [input.slug, actor.userId, input.visibility, input.description, input.networkPolicy === null ? null : JSON.stringify(input.networkPolicy)],
  );
  return rows[0]!.id;
}

/** API de l'acteur dont il est PROPRIÉTAIRE (routes d'écriture : 404 uniforme pour celle d'autrui, même `instance`). */
export async function readOwnApi(ctx: ServerContext, actor: Actor, slug: string): Promise<ApiRow | null> {
  const row = await withActor(ctx.pool, actor, (db) => readApiBySlug(db, slug));
  return row !== null && row.owner_id === actor.userId ? row : null;
}
