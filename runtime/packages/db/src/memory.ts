// SPDX-License-Identifier: AGPL-3.0-only
// Lectures de la mémoire du catalogue (tâche 2.12, 19 §2, migration 0019) : tout passe par `withActor` avec le
// propriétaire (RLS, INV12) ET par un filtre explicite `owner_id = propriétaire` — la RLS laisse lire à un membre les API
// partagées avec l'instance (`instance_read`) : elles n'entrent JAMAIS dans la mémoire d'un autre utilisateur (aucun
// partage de dossier ni de stratégie entre utilisateurs, admin compris, r1 R15). Les valeurs d'items ne sont lues que pour
// le même domaine enregistrable et hors API « avec session » (revue 2.12, 19 §2) : `requires_session`, `requires.tunnel`,
// `requires.session_domain` non vide, ou une version en tunnel (N4 : la page passe par l'extension avec la session de
// l'utilisateur) ; jamais non plus l'échantillon d'un run passé par le tunnel. Les refus (r1 R14) sont lus par une
// requête dédiée, sans limite, filtrée par propriétaire et domaine : la fenêtre des 200 API récentes ne les fait jamais
// oublier. Le dossier lui-même est construit par `buildCatalogDossier`.
// Jamais appelé au rejeu E1-E3 (seulement par l'enquête et la réparation).
import { registrableDomain, type FieldProfile, type MemoryEntry, type MemoryRef, type MemoryVersion, type PriorRefusal, type Status, type StrategySignature } from '@runtime/core';
import type { Execution, Network } from '@runtime/core';
import type pg from 'pg';
import { withActor } from './rls.js';

const MAX_APIS = 200;
const SAMPLE_MAX = 5;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

function domainOf(signature: unknown, url: string | null): string {
  if (isRecord(signature) && typeof signature['registrable_domain'] === 'string' && signature['registrable_domain'] !== '') return signature['registrable_domain'];
  if (url === null) return '';
  try {
    return registrableDomain(url);
  } catch {
    return '';
  }
}

export type CatalogMemory = { readonly entries: MemoryEntry[]; readonly refusals: PriorRefusal[]; readonly statusReason: string | null };

/** API « avec session » au sens de 19 §2 : ses items ne donnent jamais de valeur hors de son propre run. */
function sessionApi(a: { requires_session: boolean; requires: Record<string, unknown> | null }, networks: readonly Network[]): boolean {
  const sd = a.requires?.['session_domain'];
  return a.requires_session || a.requires?.['tunnel'] === true || (typeof sd === 'string' && sd.trim() !== '') || networks.includes('tunnel');
}

/**
 * Refus du propriétaire pour un domaine (r1 R14) : API `bloquee`, ou dernier run clos en `robots_disallowed` ou
 * `forbidden`. Aucune limite ; le domaine (enregistrable) est recalculé par le code après un pré-filtre SQL sur l'hôte.
 */
async function readRefusals(tx: pg.PoolClient, ownerId: string, domain: string): Promise<PriorRefusal[]> {
  if (domain === '') return [];
  const { rows } = await tx.query<{ status: Status; status_reason: string | null; updated_at: Date; url: string | null; signature: unknown; spec_url: string | null; refused_class: string | null; refused_at: Date | null }>(
    `SELECT a.status, a.status_reason, a.updated_at, a.investigation #>> '{request,url}' AS url, v.signature, v.spec #>> '{request,url}' AS spec_url,
            l.failure_class AS refused_class, l.finished_at AS refused_at
     FROM apis a
     LEFT JOIN strategy_versions v ON v.api_id = a.id AND v.version = a.current_strategy_version AND v.owner_id = $1
     LEFT JOIN LATERAL (SELECT failure_class, finished_at FROM runs r WHERE r.api_id = a.id AND r.owner_id = $1 AND r.state IN ('succeeded', 'failed')
                        ORDER BY coalesce(finished_at, created_at) DESC LIMIT 1) l ON true
     WHERE a.owner_id = $1
       AND (a.status = 'bloquee' OR l.failure_class IN ('robots_disallowed', 'forbidden'))
       AND (strpos(lower(coalesce(a.investigation #>> '{request,url}', '')), lower($2)) > 0
            OR strpos(lower(coalesce(v.spec #>> '{request,url}', '')), lower($2)) > 0
            OR v.signature ->> 'registrable_domain' = $2)`,
    [ownerId, domain],
  );
  const out: PriorRefusal[] = [];
  for (const r of rows) {
    if (domainOf(r.signature, r.url ?? r.spec_url) !== domain) continue;
    if (r.status === 'bloquee') out.push({ domain, at: iso(r.updated_at)!, class: r.status_reason === 'robots_disallowed' ? 'robots_disallowed' : 'bloquee' });
    else if (r.refused_class === 'robots_disallowed' || r.refused_class === 'forbidden') out.push({ domain, at: iso(r.refused_at ?? r.updated_at)!, class: r.refused_class });
  }
  return out;
}

/**
 * Entrées de mémoire du propriétaire (ses API seulement), avec, pour le domaine `domain` seulement, un échantillon de
 * la dernière sortie saine (5 items au plus, hors API avec session). `statusReason` : raison du statut de l'API en cours
 * (`reinvestigate_manual` après la transition 18).
 */
export async function readCatalogMemory(pool: pg.Pool, args: { ownerId: string; apiId: string | null; domain: string }): Promise<CatalogMemory> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const apis = (
      await tx.query<{
        id: string;
        slug: string;
        status: Status;
        status_reason: string | null;
        requires_session: boolean;
        requires: Record<string, unknown> | null;
        description: string;
        output_schema: unknown;
        updated_at: Date;
        url: string | null;
        current_strategy_version: number | null;
      }>(
        `SELECT id, slug, status, status_reason, requires_session, requires, description, output_schema, updated_at,
                investigation #>> '{request,url}' AS url, current_strategy_version
         FROM apis WHERE owner_id = $1 ORDER BY (id = $2::uuid) DESC, updated_at DESC LIMIT $3`,
        [args.ownerId, args.apiId, MAX_APIS],
      )
    ).rows;
    const ids = apis.map((a) => a.id);
    const refusals = await readRefusals(tx, args.ownerId, args.domain);
    if (ids.length === 0) return { entries: [], refusals, statusReason: null };
    const versions = (
      await tx.query<{ api_id: string; version: number; execution: Execution; network: Network; created_at: Date; signature: unknown; source: unknown; spec: unknown }>(
        `SELECT api_id, version, execution, network, created_at, signature, source, spec FROM strategy_versions
         WHERE owner_id = $1 AND api_id = ANY($2::uuid[]) ORDER BY api_id, version`,
        [args.ownerId, ids],
      )
    ).rows;
    const lastRuns = (
      await tx.query<{ api_id: string; healthy_at: Date | null; seen_at: Date | null; dataset_id: string | null; dataset_tunnel: boolean | null; refused_class: string | null; refused_at: Date | null }>(
        `SELECT a.id AS api_id,
                (SELECT max(finished_at) FROM runs r WHERE r.api_id = a.id AND r.owner_id = $1 AND r.state = 'succeeded') AS healthy_at,
                (SELECT max(coalesce(finished_at, created_at)) FROM runs r WHERE r.api_id = a.id AND r.owner_id = $1) AS seen_at,
                d.dataset_id, d.tunnel AS dataset_tunnel,
                l.failure_class AS refused_class, l.finished_at AS refused_at
         FROM apis a
         -- Dernière sortie saine, et si son run est passé par le tunnel (session de l'utilisateur) : jamais d'échantillon.
         LEFT JOIN LATERAL (SELECT r.dataset_id, EXISTS (SELECT 1 FROM run_attempts t WHERE t.run_id = r.id AND t.network = 'tunnel') AS tunnel
                            FROM runs r WHERE r.api_id = a.id AND r.owner_id = $1 AND r.state = 'succeeded' AND r.dataset_id IS NOT NULL
                            ORDER BY r.finished_at DESC NULLS LAST LIMIT 1) d ON true
         LEFT JOIN LATERAL (SELECT failure_class, finished_at FROM runs r WHERE r.api_id = a.id AND r.owner_id = $1 AND r.state IN ('succeeded', 'failed')
                            ORDER BY coalesce(finished_at, created_at) DESC LIMIT 1) l ON l.failure_class IN ('robots_disallowed', 'forbidden')
         WHERE a.owner_id = $1 AND a.id = ANY($2::uuid[])`,
        [args.ownerId, ids],
      )
    ).rows;
    const runOf = new Map(lastRuns.map((r) => [r.api_id, r]));
    const profiles = (
      await tx.query<{ api_id: string; profile: { fields?: Record<string, FieldProfile> } }>(
        `SELECT DISTINCT ON (api_id) api_id, profile FROM run_profiles WHERE owner_id = $1 AND api_id = ANY($2::uuid[]) ORDER BY api_id, created_at DESC`,
        [args.ownerId, ids],
      )
    ).rows;
    const profileOf = new Map(profiles.map((p) => [p.api_id, p.profile.fields ?? null]));

    const entries: MemoryEntry[] = [];
    let statusReason: string | null = null;
    for (const a of apis) {
      if (a.id === args.apiId) statusReason = a.status_reason;
      const own = versions.filter((v) => v.api_id === a.id);
      const current = own.find((v) => v.version === a.current_strategy_version);
      const domain = domainOf(current?.signature, a.url ?? (current !== undefined && isRecord(current.spec) && isRecord(current.spec['request']) ? String(current.spec['request']['url'] ?? '') : null));
      const session = sessionApi(a, own.map((v) => v.network));
      const run = runOf.get(a.id);
      const memVersions: MemoryVersion[] = own.map((v) => ({
        version: v.version,
        execution: v.execution,
        network: v.network,
        current: v.version === a.current_strategy_version,
        created_at: iso(v.created_at)!,
        superseded_by: v.version === a.current_strategy_version ? null : (own.find((w) => w.version > v.version)?.version ?? null),
      }));
      const source = isRecord(current?.source) ? current!.source : {};
      const spec = isRecord(current?.spec) ? current!.spec : {};
      const feedback = Array.isArray(source['feedback'])
        ? (source['feedback'] as unknown[]).filter(isRecord).map((f) => ({ kind: String(f['kind'] ?? ''), field: typeof f['field'] === 'string' ? f['field'] : null, text: String(f['text'] ?? ''), at: String(f['at'] ?? '') }))
        : [];
      const steps = Array.isArray(source['steps']) ? (source['steps'] as unknown[]).filter(isRecord).map((s) => String(s['intent'] ?? '')).filter((s) => s !== '') : [];
      let refusal: MemoryEntry['refusal'] = null;
      if (a.status === 'bloquee') refusal = { class: a.status_reason === 'robots_disallowed' ? 'robots_disallowed' : 'bloquee', at: iso(a.updated_at)! };
      else if (run?.refused_class === 'robots_disallowed' || run?.refused_class === 'forbidden') refusal = { class: run.refused_class, at: iso(run.refused_at ?? a.updated_at)! };
      // Valeurs : même domaine enregistrable, hors session, hors domaine refusé.
      let sample: unknown[] = [];
      if (domain === args.domain && !session && refusal === null && run?.dataset_tunnel !== true && run?.dataset_id !== null && run?.dataset_id !== undefined) {
        sample = (await tx.query<{ item: unknown }>('SELECT item FROM dataset_items WHERE dataset_id = $1 AND owner_id = $2 ORDER BY seq LIMIT $3', [run.dataset_id, args.ownerId, SAMPLE_MAX])).rows.map((r) => r.item);
      }
      let discarded: { couple: string; reason: string }[] = [];
      if (a.id === args.apiId) {
        discarded = (
          await tx.query<{ execution: string; network: string; result_class: string }>(
            `SELECT t.execution, t.network, t.result_class FROM run_attempts t JOIN runs r ON r.id = t.run_id
             WHERE r.api_id = $1 AND r.owner_id = $2 AND t.result_class IS NOT NULL AND t.result_class <> 'ok' ORDER BY t.created_at DESC LIMIT 10`,
            [a.id, args.ownerId],
          )
        ).rows.map((t) => ({ couple: `${t.execution}/${t.network}`, reason: t.result_class }));
      }
      entries.push({
        api_id: a.id,
        owner_id: args.ownerId,
        slug: a.slug,
        domain,
        status: a.status,
        status_reason: a.status_reason,
        session,
        description: a.description,
        observed_at: iso(run?.seen_at ?? a.updated_at)!,
        last_healthy_at: iso(run?.healthy_at ?? null),
        versions: memVersions,
        signature: isRecord(current?.signature) ? (current!.signature as unknown as StrategySignature) : null,
        endpoint: isRecord(spec['request']) && typeof spec['request']['url'] === 'string' ? spec['request']['url'] : null,
        pagination: isRecord(spec['pagination']) && typeof spec['pagination']['type'] === 'string' ? spec['pagination']['type'] : null,
        discarded,
        feedback,
        step_intents: steps,
        output_schema: a.output_schema,
        fields: profileOf.get(a.id) ?? null,
        sample,
        refusal,
      });
    }
    return { entries, refusals, statusReason };
  });
}

/** Source d'une version : entrées consultées, étage, sha256 du dossier (`strategy_version_memory_refs`). */
export async function recordMemoryRefs(pool: pg.Pool, args: { ownerId: string; apiId: string; version: number; refs: readonly MemoryRef[]; sha256: string }): Promise<void> {
  if (args.refs.length === 0) return;
  await withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    for (const r of args.refs) {
      await tx.query(
        `INSERT INTO strategy_version_memory_refs (api_id, strategy_version, owner_id, ref_api_id, ref_version, tier, dossier_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (api_id, strategy_version, ref_api_id) DO UPDATE SET tier = EXCLUDED.tier, dossier_sha256 = EXCLUDED.dossier_sha256`,
        [args.apiId, args.version, args.ownerId, r.ref_api_id, r.ref_version, r.tier, args.sha256],
      );
    }
  });
}

export async function readMemoryRefs(pool: pg.Pool, args: { ownerId: string; apiId: string; version: number }): Promise<{ ref_api_id: string; ref_version: number | null; tier: number; dossier_sha256: string }[]> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) =>
    (
      await tx.query<{ ref_api_id: string; ref_version: number | null; tier: number; dossier_sha256: string }>(
        'SELECT ref_api_id, ref_version, tier, dossier_sha256 FROM strategy_version_memory_refs WHERE api_id = $1 AND strategy_version = $2 AND owner_id = $3 ORDER BY tier, ref_api_id',
        [args.apiId, args.version, args.ownerId],
      )
    ).rows,
  );
}

/** Signature calculée par le code à la reconnaissance, posée sur la version (sans LLM, sans texte du site). */
export async function saveStrategySignature(pool: pg.Pool, args: { ownerId: string; apiId: string; version: number; signature: StrategySignature }): Promise<void> {
  await withActor(pool, { userId: args.ownerId, role: 'member' }, (tx) =>
    tx.query('UPDATE strategy_versions SET signature = $4::jsonb WHERE api_id = $1 AND version = $2 AND owner_id = $3', [args.apiId, args.version, args.ownerId, JSON.stringify(args.signature)]),
  );
}
