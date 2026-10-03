// SPDX-License-Identifier: AGPL-3.0-only
// Dossier d'enquête en base (tâche 2.14, 19c § 4, migration 0021) : versions immuables du dossier MASQUÉ (`api_briefs`,
// versionné par remplacement : même contenu renvoyé, pas de nouvelle version ; au plus `BRIEF_VERSIONS_KEEP`) et faits
// du code par indice (`brief_hint_outcomes`, clé d'identité, survivent au remplacement). Toute lecture filtre
// EXPLICITEMENT `owner_id` (en plus de la RLS) : le worker, même sous le rôle de service, ne lit jamais le dossier d'un
// autre propriétaire que celui de l'API (assert_clone_no_brief, assert_brief_not_cross_api).
import { createHash } from 'node:crypto';
import { briefSha256, type FinalHint, type HintOutcomeFact, type InvestigationBrief, type NormalizedBrief, type StrategySourceBrief } from '@runtime/core';
import type pg from 'pg';
import { withActor } from './rls.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export type StoredBrief = {
  readonly version: number;
  readonly sha256: string;
  readonly content: InvestigationBrief;
  readonly size_bytes: number;
  readonly subject_excluded: readonly string[];
  readonly created_at: string;
  readonly erased: boolean;
};

type BriefRow = { brief_version: number; content_sha256: string; content: InvestigationBrief; size_bytes: number; subject_excluded: string[]; created_at: Date; erased_at: Date | null };
const toStored = (r: BriefRow): StoredBrief => ({
  version: r.brief_version,
  sha256: r.content_sha256,
  content: r.content,
  size_bytes: r.size_bytes,
  subject_excluded: r.subject_excluded,
  created_at: r.created_at.toISOString(),
  erased: r.erased_at !== null,
});
const COLUMNS = 'brief_version, content_sha256, content, size_bytes, subject_excluded, created_at, erased_at';

/**
 * Enregistre une version du dossier normalisé (dans la transaction de l'appelant, propriétaire de l'API). Même empreinte
 * qu'une version non effacée : aucune version de plus (`created: false`). Puis garde au plus `keep` versions : la plus
 * ancienne non référencée par une version de stratégie (`source.brief.ref`) est purgée.
 */
export async function storeBrief(
  tx: Queryable,
  args: { apiId: string; ownerId: string; authorId: string | null; via: 'mcp' | 'rest' | 'console'; normalized: NormalizedBrief; keep: number },
): Promise<{ version: number; sha256: string; created: boolean }> {
  await tx.query('SELECT 1 FROM apis WHERE id = $1 AND owner_id = $2 FOR UPDATE', [args.apiId, args.ownerId]);
  const same = await tx.query<{ brief_version: number }>('SELECT brief_version FROM api_briefs WHERE api_id = $1 AND owner_id = $2 AND content_sha256 = $3 AND erased_at IS NULL', [
    args.apiId,
    args.ownerId,
    args.normalized.sha256,
  ]);
  if (same.rows[0] !== undefined) return { version: same.rows[0].brief_version, sha256: args.normalized.sha256, created: false };
  const next = await tx.query<{ v: number }>('SELECT COALESCE(MAX(brief_version), 0) + 1 AS v FROM api_briefs WHERE api_id = $1', [args.apiId]);
  const version = next.rows[0]!.v;
  await tx.query(
    `INSERT INTO api_briefs (api_id, owner_id, brief_version, content, content_sha256, size_bytes, subject_excluded, author_id, via)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::text[], $8, $9)`,
    [args.apiId, args.ownerId, version, JSON.stringify(args.normalized.brief), args.normalized.sha256, args.normalized.bytes, [...args.normalized.subjectExcluded], args.authorId, args.via],
  );
  await pruneBriefVersions(tx, { apiId: args.apiId, keep: args.keep });
  return { version, sha256: args.normalized.sha256, created: true };
}

/** `BRIEF_VERSIONS_KEEP` : versions au-delà de `keep` (les plus anciennes), sauf celles qu'une version de stratégie référence. */
export async function pruneBriefVersions(db: Queryable, args: { apiId?: string; keep: number }): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM api_briefs b USING (
       SELECT id, row_number() OVER (PARTITION BY api_id ORDER BY brief_version DESC) AS rn FROM api_briefs WHERE ($1::uuid IS NULL OR api_id = $1)
     ) r
     WHERE b.id = r.id AND r.rn > $2
       AND NOT EXISTS (SELECT 1 FROM strategy_versions s WHERE s.api_id = b.api_id AND s.source -> 'brief' -> 'ref' ->> 'version' = b.brief_version::text)`,
    [args.apiId ?? null, Math.max(1, args.keep)],
  );
  return rowCount ?? 0;
}

/** Dernière version du dossier de l'API (propriétaire de l'API seulement, filtre explicite). */
export async function readLatestBrief(db: Queryable, args: { apiId: string; ownerId: string }): Promise<StoredBrief | null> {
  const { rows } = await db.query<BriefRow>(
    `SELECT ${COLUMNS} FROM api_briefs b WHERE b.api_id = $1 AND b.owner_id = $2
       AND EXISTS (SELECT 1 FROM apis a WHERE a.id = b.api_id AND a.owner_id = $2)
     ORDER BY brief_version DESC LIMIT 1`,
    [args.apiId, args.ownerId],
  );
  return rows[0] === undefined ? null : toStored(rows[0]);
}

/** Une version précise (source d'une version de stratégie), propriétaire de l'API seulement. */
export async function readBriefVersion(db: Queryable, args: { apiId: string; ownerId: string; version: number }): Promise<StoredBrief | null> {
  const { rows } = await db.query<BriefRow>(
    `SELECT ${COLUMNS} FROM api_briefs b WHERE b.api_id = $1 AND b.owner_id = $2 AND b.brief_version = $3
       AND EXISTS (SELECT 1 FROM apis a WHERE a.id = b.api_id AND a.owner_id = $2)`,
    [args.apiId, args.ownerId, args.version],
  );
  return rows[0] === undefined ? null : toStored(rows[0]);
}

/**
 * Dossier à relire pour une enquête, une réparation ou une recompilation (19c § 4) : la version de la source de la
 * version courante (`source.brief.ref`) si elle existe encore, sinon la dernière version ; jamais un dossier d'un autre
 * propriétaire (clone ou transfert : `source.brief.ref` à `null`, aucune ligne).
 */
export async function readBriefForApi(pool: pg.Pool, args: { apiId: string; ownerId: string; preferVersion?: number | null }): Promise<{ brief: StoredBrief; outcomes: Map<string, HintOutcomeFact> } | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const preferred = args.preferVersion !== undefined && args.preferVersion !== null ? await readBriefVersion(tx, { apiId: args.apiId, ownerId: args.ownerId, version: args.preferVersion }) : null;
    const brief = preferred ?? (await readLatestBrief(tx, { apiId: args.apiId, ownerId: args.ownerId }));
    if (brief === null) return null;
    return { brief, outcomes: await readHintOutcomes(tx, { apiId: args.apiId, ownerId: args.ownerId }) };
  });
}

/** Faits du code par clé d'identité (mémoire négative, péremption). */
export async function readHintOutcomes(db: Queryable, args: { apiId: string; ownerId: string }): Promise<Map<string, HintOutcomeFact>> {
  const { rows } = await db.query<{ identity_key: string; state: HintOutcomeFact['state']; reason: string | null; probed_at: Date | null; last_ok_at: Date | null }>(
    'SELECT identity_key, state, reason, probed_at, last_ok_at FROM brief_hint_outcomes WHERE api_id = $1 AND owner_id = $2',
    [args.apiId, args.ownerId],
  );
  return new Map(rows.map((r) => [r.identity_key, { identity_key: r.identity_key, state: r.state, reason: r.reason, probed_at: r.probed_at?.toISOString() ?? null, last_ok_at: r.last_ok_at?.toISOString() ?? null }]));
}

const STALE_DAYS: Readonly<Record<string, number>> = { selector: 30, example_url: 30, embedded_data: 60, endpoint: 90, pagination: 90, pitfall: 180 };

/**
 * Faits du code après une enquête (19c § 9.2) : un indice confirmé, en échec ou écarté devient une ligne (clé d'identité) ;
 * un indice non vérifié n'en crée pas. Sonde : date, classe HTTP, items conformes, durée, coût ; jamais de corps.
 */
export async function saveHintOutcomes(pool: pg.Pool, args: { apiId: string; ownerId: string; version: number; hints: readonly FinalHint[]; now: Date }): Promise<void> {
  const rows = args.hints.filter((h) => h.state !== 'unverified');
  if (rows.length === 0) return;
  await withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    for (const h of rows) {
      const ok = h.state === 'used' || h.state === 'verified_unused';
      const probedAt = h.probe?.at ?? null;
      const expires = ok ? new Date(args.now.getTime() + (STALE_DAYS[h.kind] ?? 30) * 86_400_000) : null;
      await tx.query(
        `INSERT INTO brief_hint_outcomes (api_id, owner_id, identity_key, brief_version, hint_id, kind, state, reason, probe, stale, expires_at, probed_at, last_ok_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14)
         ON CONFLICT (api_id, identity_key) DO UPDATE SET brief_version = EXCLUDED.brief_version, hint_id = EXCLUDED.hint_id, state = EXCLUDED.state,
           reason = EXCLUDED.reason, probe = COALESCE(EXCLUDED.probe, brief_hint_outcomes.probe), stale = EXCLUDED.stale, expires_at = EXCLUDED.expires_at,
           probed_at = COALESCE(EXCLUDED.probed_at, brief_hint_outcomes.probed_at), last_ok_at = COALESCE(EXCLUDED.last_ok_at, brief_hint_outcomes.last_ok_at),
           updated_at = EXCLUDED.updated_at`,
        [
          args.apiId,
          args.ownerId,
          h.identity_key,
          args.version,
          h.id,
          h.kind,
          h.state,
          h.reason,
          h.probe === null ? null : JSON.stringify(h.probe),
          h.stale,
          expires,
          probedAt,
          ok ? (probedAt ?? args.now.toISOString()) : null,
          args.now,
        ],
      );
    }
  });
}

/**
 * Événement de preuve `brief_hint_verified` (19c § 6) : un seul par clé d'identité et par jour ; `true` si cet appel le
 * réserve (run réel seulement : l'appelant ne l'appelle jamais pour une sonde rejouée ni un renvoi du même dossier).
 */
export async function claimHintVerifiedEvent(pool: pg.Pool, args: { apiId: string; ownerId: string; identityKey: string; day: string }): Promise<boolean> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE brief_hint_outcomes SET verified_event_day = $4::date
       WHERE api_id = $1 AND owner_id = $2 AND identity_key = $3 AND (verified_event_day IS NULL OR verified_event_day < $4::date)`,
      [args.apiId, args.ownerId, args.identityKey, args.day],
    );
    return (rowCount ?? 0) === 1;
  });
}

export type BriefHintRow = {
  readonly identity_key: string;
  readonly hint_id: string;
  readonly kind: string;
  readonly state: string;
  readonly reason: string | null;
  readonly cost_usd: number | null;
  readonly brief_version: number;
  readonly stale: boolean;
  readonly probed_at: string | null;
  readonly last_ok_at: string | null;
};

/**
 * Liste des indices de la fiche API (console, 19c § 7) : faits du code (état, raison, coût, version du dossier) et version
 * du dossier utilisée par chaque version de stratégie. Propriétaire seulement (l'appelant a vérifié la propriété) ; aucune
 * valeur ni texte du dossier.
 */
export async function briefHintsView(db: Queryable, args: { apiId: string; ownerId: string }): Promise<{
  latest: { version: number; created_at: string; hints: number; tried: number; open_questions: number; erased: boolean } | null;
  hints: BriefHintRow[];
  versions: { strategy_version: number; brief_version: number | null; used: number; ignored: number }[];
}> {
  const latest = await readLatestBrief(db, args);
  const hints = await db.query<{ identity_key: string; hint_id: string; kind: string; state: string; reason: string | null; probe: { cost_usd?: number } | null; brief_version: number; stale: boolean; probed_at: Date | null; last_ok_at: Date | null }>(
    'SELECT identity_key, hint_id, kind, state, reason, probe, brief_version, stale, probed_at, last_ok_at FROM brief_hint_outcomes WHERE api_id = $1 AND owner_id = $2 ORDER BY brief_version DESC, hint_id',
    [args.apiId, args.ownerId],
  );
  const versions = await db.query<{ version: number; brief: StrategySourceBrief | null }>(
    "SELECT version, source -> 'brief' AS brief FROM strategy_versions WHERE api_id = $1 AND owner_id = $2 ORDER BY version DESC LIMIT 50",
    [args.apiId, args.ownerId],
  );
  return {
    latest:
      latest === null
        ? null
        : {
            version: latest.version,
            created_at: latest.created_at,
            hints: (latest.content.hints ?? []).length,
            tried: (latest.content.tried ?? []).length,
            open_questions: (latest.content.open_questions ?? []).length,
            erased: latest.erased,
          },
    hints: hints.rows.map((r) => ({
      identity_key: r.identity_key,
      hint_id: r.hint_id,
      kind: r.kind,
      state: r.state,
      reason: r.reason,
      cost_usd: typeof r.probe?.cost_usd === 'number' ? r.probe.cost_usd : null,
      brief_version: r.brief_version,
      stale: r.stale,
      probed_at: r.probed_at?.toISOString() ?? null,
      last_ok_at: r.last_ok_at?.toISOString() ?? null,
    })),
    versions: versions.rows.map((v) => ({ strategy_version: v.version, brief_version: v.brief?.ref?.version ?? null, used: v.brief?.used?.length ?? 0, ignored: v.brief?.ignored?.length ?? 0 })),
  };
}

/**
 * Minimisation (19c § 4, `RETENTION_SAMPLES_DAYS`) : passé le délai, chaque `hints[].sample` d'une version est remplacé par
 * son empreinte (`sha256:…`), empreinte de la version recalculée. Passe système (purge), toutes API confondues.
 */
export async function purgeBriefSamples(db: Queryable, before: Date, now: Date): Promise<number> {
  const { rows } = await db.query<{ id: string; content: InvestigationBrief }>(
    `SELECT id, content FROM api_briefs WHERE created_at < $1 AND samples_purged_at IS NULL AND jsonb_path_exists(content, '$.hints[*].sample')`,
    [before],
  );
  for (const row of rows) {
    const hints = (row.content.hints ?? []).map((h) => (h.sample === undefined || h.sample.startsWith('sha256:') ? h : { ...h, sample: `sha256:${createHash('sha256').update(h.sample).digest('hex')}` }));
    const content: InvestigationBrief = { ...row.content, hints };
    await db.query('UPDATE api_briefs SET content = $2::jsonb, content_sha256 = $3, size_bytes = $4, samples_purged_at = $5 WHERE id = $1', [
      row.id,
      JSON.stringify(content),
      briefSha256(content),
      Buffer.byteLength(JSON.stringify(content), 'utf8'),
      now,
    ]);
  }
  return rows.length;
}
