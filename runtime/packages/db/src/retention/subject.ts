// SPDX-License-Identifier: AGPL-3.0-only
// Droits des personnes (RGPD art. 15 et 17 ; 17 § 6) : `export_subject`, `erase_subject`, liste d'exclusion hachée.
//
// Le sujet est désigné par des valeurs **identifiantes** (e-mail, téléphone, nom complet) : `resolveSubjectValues` les
// lit dans un item d'après le `output_schema` de son API (`x-personal: identifier` ou `true`, chaînes seulement). Une
// valeur qui ne désigne personne (booléen, nombre, date, prénom seul) est refusée (`assertUsableSubject`).
//
// Portée (revue de 1.8) : `{ ownerId }` limite tout aux données de ce propriétaire ; `{ instance: true }` est réservée à
// l'administrateur de l'instance ou au système. L'administrateur n'accède jamais au contenu d'un autre utilisateur
// (A3, INV5, INV12) : l'export lui rend des métadonnées et les seules valeurs identifiantes du sujet ; le contenu
// (items, entrées, journaux, échantillons) ne sort que pour son propriétaire. Tout est tracé dans `audit_events`.
//
// Effacement (une transaction, après un `dry_run` imposé dont la confirmation est exigée) :
//  - dataset_items : un item est supprimé si l'une de ses valeurs identifiantes (ou sa clé de déduplication) a l'empreinte
//    d'une valeur demandée : **égalité exacte** sur les champs `x-personal`, jamais une sous-chaîne ; un item qui ne fait
//    que mentionner le sujet (texte libre) est expurgé (`[erased]`) ; compteurs des datasets recalculés ;
//  - dedup_keys : clés dont `key_hash` = `dedupKeyHash` d'une valeur demandée ou de la clé d'un item supprimé ;
//  - run_logs, runs (input, error_detail), investigation_events (dont les échantillons), run_rejected_items (échantillon
//    de la quarantaine, D-49), status_events, tunnel_jobs,
//    schedules (input) : valeur remplacée par `[erased]` (motif borné aux limites de mot) ;
//  - run_artifacts (chiffrés, donc illisibles) : supprimés pour tout run lié au sujet ;
//  - subject_exclusions : HMAC-SHA256 de chaque valeur normalisée (téléphones en E.164), clé des sujets de l'instance ;
//  - vérification : balayage SQL brut des tables de contenu (et des charges pg-boss) ; un résidu annule la transaction.
// Hors outil : les comptes (`users`, `auth_*`) et l'audit, jamais balayés ici (ni compte ni contenu rendu).
import { createHash } from 'node:crypto';
import {
  dedupKeyHash,
  extractSubjectIdentifiers,
  isUsableSubjectValue,
  normalizeSubjectValue,
  subjectHash,
  subjectHashes,
  subjectSearchPatterns,
  subjectSearchRegex,
} from '@runtime/core';
import type pg from 'pg';
import { appendAudit } from '../audit.js';
import { countQueuePayloadMatches } from '../queue.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export const ERASED = '[erased]';

export type SubjectActor = {
  userId: string | null;
  via: 'ui' | 'apikey' | 'mcp' | 'sso' | 'system';
  ref?: string | null;
  /** Administrateur de l'instance (rôle vérifié par l'appelant) : seul admis, avec le système, en portée instance. */
  instanceAdmin?: boolean;
};
/** `{ ownerId }` : données de ce propriétaire seulement ; `{ instance: true }` : toute l'instance (admin ou système). */
export type SubjectScope = { ownerId: string } | { instance: true };
export type SubjectRequest = {
  /** Valeurs identifiantes de la personne (e-mail, téléphone, nom complet). */
  values: readonly string[];
  /** Clé HMAC des sujets de l'instance (`loadSubjectKey`). */
  key: Buffer;
  actor: SubjectActor;
  scope: SubjectScope;
};

export class SubjectErasureNotConfirmedError extends Error {
  override name = 'SubjectErasureNotConfirmedError';
}
export class SubjectErasureIncompleteError extends Error {
  override name = 'SubjectErasureIncompleteError';
  readonly residual: Record<string, number>;
  constructor(residual: Record<string, number>) {
    super(`effacement incomplet, transaction annulée : occurrences restantes dans ${Object.keys(residual).join(', ')}.`);
    this.residual = residual;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Valeurs, portée et motifs
// ---------------------------------------------------------------------------------------------------------------
/** Refuse une demande sans valeur, ou dont une valeur ne désigne personne (booléen, date, nombre, prénom seul…). */
export function assertUsableSubject(values: readonly string[]): void {
  const filled = values.filter((v) => typeof v === 'string' && v.trim() !== '');
  const unusable = filled.filter((v) => !isUsableSubjectValue(v));
  if (filled.length === 0 || unusable.length > 0) {
    throw new Error(
      'sujet refusé : au moins une valeur, et chacune doit désigner une personne (e-mail, téléphone, ou nom d’au moins 8 caractères ; ni booléen, ni date, ni nombre).',
    );
  }
}

function assertScope(req: SubjectRequest): void {
  if ('ownerId' in req.scope) {
    if (!req.scope.ownerId) throw new Error('portée invalide : ownerId requis.');
    return;
  }
  if (req.actor.via !== 'system' && req.actor.instanceAdmin !== true) {
    throw new Error('portée instance refusée : réservée à l’administrateur de l’instance ; passez { ownerId } pour vos données.');
  }
}

/** Clause de portée sur `owner_id` (paramètre `$n`), et ses paramètres. */
function ownerFilter(scope: SubjectScope, n: number, column = 'owner_id'): { sql: string; params: unknown[] } {
  return 'ownerId' in scope ? { sql: ` AND ${column} = $${n}`, params: [scope.ownerId] } : { sql: '', params: [] };
}

/** Motifs de recherche (bornés aux limites de mot ; téléphone : formes internationale et nationale). */
export const searchForms = subjectSearchPatterns;
export const subjectRegex = subjectSearchRegex;

/** Valeurs identifiantes d'un item d'un dataset, d'après le `output_schema` de son API : point de départ d'une demande. */
export async function resolveSubjectValues(db: Queryable, ref: { datasetId: string; seq: number }): Promise<string[]> {
  const { rows } = await db.query<{ item: unknown; output_schema: unknown }>(
    `SELECT i.item, a.output_schema FROM dataset_items i
       JOIN datasets d ON d.id = i.dataset_id JOIN apis a ON a.id = d.api_id
      WHERE i.dataset_id = $1 AND i.seq = $2 LIMIT 1`,
    [ref.datasetId, ref.seq],
  );
  const row = rows[0];
  return row ? extractSubjectIdentifiers(row.output_schema, row.item) : [];
}

// ---------------------------------------------------------------------------------------------------------------
// Liste d'exclusion
// ---------------------------------------------------------------------------------------------------------------
/** Empreintes exclues, à charger avant la collecte (`loadSubjectExclusions`) puis à opposer avant écriture. */
export async function loadSubjectExclusions(db: Queryable): Promise<Set<string>> {
  const { rows } = await db.query<{ subject_hash: string }>('SELECT subject_hash FROM subject_exclusions');
  return new Set(rows.map((r) => r.subject_hash));
}

/** Une valeur (e-mail, téléphone…) figure-t-elle dans la liste d'exclusion ? */
export async function isSubjectExcluded(db: Queryable, key: Buffer, value: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM subject_exclusions WHERE subject_hash = $1', [subjectHash(key, value)]);
  return rowCount === 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Tables de contenu : balayage de vérification et expurgation
// ---------------------------------------------------------------------------------------------------------------
/**
 * Tables balayées par l'outil (liste fermée). Jamais `users`, `auth_*`, `verifications`, `api_keys`, `secrets`,
 * `invitations` ni `audit_events` : ni compte ni contenu n'en sort, même agrégé (pas d'oracle de sous-chaîne).
 */
export const SUBJECT_CONTENT_TABLES = ['dataset_items', 'runs', 'run_logs', 'investigation_events', 'run_rejected_items', 'status_events', 'tunnel_jobs', 'schedules'] as const;

/**
 * Nombre de lignes des tables de contenu contenant une valeur du sujet (SQL brut sur `to_jsonb(ligne)`, motif borné aux
 * limites de mot), dans la portée ; plus les charges des jobs pg-boss (`pgboss.job`). Vérification de l'effacement.
 */
export async function countSubjectOccurrences(db: Queryable, values: readonly string[], scope: SubjectScope): Promise<Record<string, number>> {
  const pattern = subjectRegex(values);
  const out: Record<string, number> = {};
  if (pattern === null) return out;
  for (const table of SUBJECT_CONTENT_TABLES) {
    const f = ownerFilter(scope, 2, 't.owner_id');
    const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} t WHERE to_jsonb(t)::text ~* $1${f.sql}`, [pattern, ...f.params]);
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) out[table] = n;
  }
  const jobs = await countQueuePayloadMatches(db as Parameters<typeof countQueuePayloadMatches>[0], pattern);
  if (jobs > 0) out['pgboss.job'] = jobs;
  return out;
}

/** Copie d'une valeur JSON où chaque forme du sujet est remplacée par `[erased]` (chaînes, clés, nombres). */
export function scrubSubject(value: unknown, values: readonly string[]): unknown {
  const source = subjectRegex(values);
  const re = source ? new RegExp(source, 'gi') : null;
  const norms = new Set(values.map(normalizeSubjectValue).filter((v) => v !== ''));
  const text = (s: string) => (re ? s.replace(re, ERASED) : s);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return text(v);
    if (typeof v === 'number') return norms.has(normalizeSubjectValue(String(v))) ? ERASED : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x)]));
    return v;
  };
  return walk(value);
}

type ScrubTarget = { table: string; pk: string[]; json: string[]; text: string[] };
const SCRUB_TARGETS: Record<'run_logs' | 'runs' | 'investigation_events' | 'run_rejected_items' | 'status_events' | 'tunnel_jobs' | 'schedules', ScrubTarget> = {
  run_logs: { table: 'run_logs', pk: ['run_id', 'seq'], json: ['data'], text: ['event'] },
  runs: { table: 'runs', pk: ['id'], json: ['input'], text: ['error_detail'] },
  investigation_events: { table: 'investigation_events', pk: ['run_id', 'seq'], json: ['payload'], text: [] },
  // Quarantaine (D-49, 0017) : l'échantillon nettoyé et les pointeurs des raisons (une clé inconnue vient du site).
  run_rejected_items: { table: 'run_rejected_items', pk: ['run_id'], json: ['sample', 'by_reason'], text: [] },
  status_events: { table: 'status_events', pk: ['id'], json: [], text: ['reason'] },
  tunnel_jobs: { table: 'tunnel_jobs', pk: ['job_id'], json: ['payload', 'trace'], text: [] },
  schedules: { table: 'schedules', pk: ['id'], json: ['input'], text: [] },
};

function matchClause(t: ScrubTarget, param: string): string {
  const cols = [...t.json.map((c) => `${c}::text`), ...t.text];
  return `(${cols.map((c) => `${c} ~* ${param}`).join(' OR ')})`;
}

async function matchingRows<T extends pg.QueryResultRow>(db: Queryable, t: ScrubTarget, cols: string[], pattern: string, scope: SubjectScope, order = ''): Promise<T[]> {
  const f = ownerFilter(scope, 2);
  return (await db.query<T>(`SELECT ${cols.join(', ')} FROM ${t.table} WHERE ${matchClause(t, '$1')}${f.sql}${order}`, [pattern, ...f.params])).rows;
}

// ---------------------------------------------------------------------------------------------------------------
// Plan : items concernés (égalité exacte sur les identifiants) et items qui ne font que mentionner le sujet
// ---------------------------------------------------------------------------------------------------------------
type CandidateItem = {
  created_at: Date;
  /** `created_at` en texte (microsecondes) : clé exacte de la ligne, qu'un `Date` JavaScript tronquerait. */
  created_key: string;
  dataset_id: string;
  seq: number;
  owner_id: string;
  run_id: string | null;
  api_id: string;
  item: unknown;
  dedup_key: string | null;
  output_schema: unknown;
};
type Classified = { subject: CandidateItem[]; mentions: CandidateItem[] };

async function classifyItems(db: Queryable, req: SubjectRequest, pattern: string): Promise<Classified> {
  const f = ownerFilter(req.scope, 2, 'i.owner_id');
  const { rows } = await db.query<CandidateItem>(
    `SELECT i.created_at, i.created_at::text AS created_key, i.dataset_id, i.seq, i.owner_id, i.run_id, d.api_id, i.item, i.dedup_key, a.output_schema
       FROM dataset_items i JOIN datasets d ON d.id = i.dataset_id JOIN apis a ON a.id = d.api_id
      WHERE (i.item::text ~* $1 OR i.dedup_key ~* $1)${f.sql}
      ORDER BY i.created_at, i.dataset_id, i.seq`,
    [pattern, ...f.params],
  );
  const wanted = new Set(subjectHashes(req.key, req.values));
  const out: Classified = { subject: [], mentions: [] };
  for (const row of rows) {
    const ids = extractSubjectIdentifiers(row.output_schema, row.item);
    const dedupMatch = row.dedup_key !== null && wanted.has(subjectHash(req.key, row.dedup_key));
    if (dedupMatch || ids.some((v) => wanted.has(subjectHash(req.key, v)))) out.subject.push(row);
    else out.mentions.push(row);
  }
  return out;
}

export type ErasePlan = {
  datasets: { dataset_id: string; owner_id: string; api_id: string; items_deleted: number; items_scrubbed: number }[];
  owners: string[];
  /** Lignes des autres tables de contenu où une valeur sera expurgée. */
  rows: Record<string, number>;
  /** À renvoyer dans `eraseSubject(..., { confirm })` : empreinte du plan (valeurs, portée, datasets et comptes). */
  confirmation: string;
};

function buildPlan(req: SubjectRequest, items: Classified, rows: Record<string, number>): ErasePlan {
  const byDataset = new Map<string, ErasePlan['datasets'][number]>();
  const at = (r: CandidateItem) => {
    let e = byDataset.get(r.dataset_id);
    if (!e) byDataset.set(r.dataset_id, (e = { dataset_id: r.dataset_id, owner_id: r.owner_id, api_id: r.api_id, items_deleted: 0, items_scrubbed: 0 }));
    return e;
  };
  for (const r of items.subject) at(r).items_deleted += 1;
  for (const r of items.mentions) at(r).items_scrubbed += 1;
  const datasets = [...byDataset.values()].sort((a, b) => a.dataset_id.localeCompare(b.dataset_id));
  const owners = [...new Set(datasets.map((d) => d.owner_id))].sort();
  const confirmation = createHash('sha256')
    .update(JSON.stringify({ h: [...subjectHashes(req.key, req.values)].sort(), s: req.scope, datasets, rows }))
    .digest('hex')
    .slice(0, 16);
  return { datasets, owners, rows, confirmation };
}

async function scrubRowCounts(db: Queryable, req: SubjectRequest, pattern: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of Object.values(SCRUB_TARGETS)) {
    const f = ownerFilter(req.scope, 2);
    const n = Number((await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t.table} WHERE ${matchClause(t, '$1')}${f.sql}`, [pattern, ...f.params])).rows[0]?.n ?? 0);
    if (n > 0) out[t.table] = n;
  }
  return out;
}

async function relatedRunIds(db: Queryable, req: SubjectRequest, pattern: string, items: CandidateItem[]): Promise<string[]> {
  const ids = new Set(items.map((r) => r.run_id).filter((x): x is string => x !== null));
  for (const t of [SCRUB_TARGETS.runs, SCRUB_TARGETS.run_logs, SCRUB_TARGETS.investigation_events, SCRUB_TARGETS.tunnel_jobs]) {
    const col = t.table === 'runs' ? 'id::text AS run_id' : 'run_id::text AS run_id';
    for (const r of await matchingRows<{ run_id: string | null }>(db, t, [col], pattern, req.scope)) if (r.run_id) ids.add(r.run_id);
  }
  return [...ids];
}

// ---------------------------------------------------------------------------------------------------------------
// export_subject
// ---------------------------------------------------------------------------------------------------------------
export type SubjectExport = {
  generated_at: string;
  scope: 'owner' | 'instance';
  /** `true` : contenu rendu (le demandeur est le propriétaire des données) ; `false` : métadonnées seulement. */
  content: boolean;
  /** Empreintes HMAC des valeurs demandées (les valeurs elles-mêmes ne sont pas répétées). */
  subject_hashes: string[];
  excluded: boolean;
  dataset_items: {
    dataset_id: string;
    api_id: string;
    owner_id: string;
    seq: number;
    created_at: string;
    run_id: string | null;
    /** Valeurs identifiantes du sujet trouvées dans l'item (les siennes, égales aux valeurs demandées). */
    matched: string[];
    /** Contenu de l'item : propriétaire seulement. */
    item?: unknown;
  }[];
  runs: { id: string; api_id: string; owner_id: string; created_at: string; input?: unknown; error_detail?: string | null }[];
  run_logs: { run_id: string; seq: number; ts: string; level: string; event?: string; data?: unknown }[];
  investigation_events: { run_id: string; seq: number; kind: string; at: string; payload?: unknown }[];
  run_artifacts: { id: string; run_id: string; kind: string; bytes: number; created_at: string }[];
};

/**
 * JSON de ce que l'instance détient sur le sujet (art. 15), dans la portée. Contenu rendu au seul propriétaire des
 * données (portée `{ ownerId }` égale à l'acteur) ; sinon métadonnées et valeurs identifiantes du sujet. Tracé.
 */
export async function exportSubject(pool: pg.Pool, req: SubjectRequest, now: Date = new Date()): Promise<SubjectExport> {
  assertUsableSubject(req.values);
  assertScope(req);
  const content = 'ownerId' in req.scope && req.actor.userId === req.scope.ownerId;
  const hashes = subjectHashes(req.key, req.values);
  const wanted = new Set(hashes);
  const pattern = subjectRegex(req.values)!;
  const iso = (d: Date) => d.toISOString();
  const items = (await classifyItems(pool, req, pattern)).subject;
  const runs = await matchingRows<{ id: string; api_id: string; owner_id: string; created_at: Date; input: unknown; error_detail: string | null }>(
    pool, SCRUB_TARGETS.runs, ['id', 'api_id', 'owner_id', 'created_at', 'input', 'error_detail'], pattern, req.scope, ' ORDER BY created_at');
  const logs = await matchingRows<{ run_id: string; seq: number; ts: Date; level: string; event: string; data: unknown }>(
    pool, SCRUB_TARGETS.run_logs, ['run_id', 'seq', 'ts', 'level', 'event', 'data'], pattern, req.scope, ' ORDER BY ts');
  const events = await matchingRows<{ run_id: string; seq: number; kind: string; at: Date; payload: unknown }>(
    pool, SCRUB_TARGETS.investigation_events, ['run_id', 'seq', 'kind', 'at', 'payload'], pattern, req.scope, ' ORDER BY at');
  const runIds = await relatedRunIds(pool, req, pattern, items);
  const f = ownerFilter(req.scope, 2);
  const artifacts = (
    await pool.query<{ id: string; run_id: string; kind: string; bytes: number; created_at: Date }>(
      `SELECT id, run_id, kind, bytes, created_at FROM run_artifacts WHERE run_id = ANY($1::uuid[])${f.sql} ORDER BY created_at`,
      [runIds, ...f.params],
    )
  ).rows;
  const excluded = (await pool.query('SELECT 1 FROM subject_exclusions WHERE subject_hash = ANY($1::text[]) LIMIT 1', [hashes])).rowCount === 1;
  const out: SubjectExport = {
    generated_at: iso(now),
    scope: 'ownerId' in req.scope ? 'owner' : 'instance',
    content,
    subject_hashes: hashes,
    excluded,
    dataset_items: items.map((r) => ({
      dataset_id: r.dataset_id,
      api_id: r.api_id,
      owner_id: r.owner_id,
      seq: r.seq,
      created_at: iso(r.created_at),
      run_id: r.run_id,
      matched: extractSubjectIdentifiers(r.output_schema, r.item).filter((v) => wanted.has(subjectHash(req.key, v))),
      ...(content ? { item: r.item } : {}),
    })),
    runs: runs.map((r) => ({
      id: r.id,
      api_id: r.api_id,
      owner_id: r.owner_id,
      created_at: iso(r.created_at),
      ...(content ? { input: r.input, error_detail: r.error_detail } : {}),
    })),
    run_logs: logs.map((r) => ({ run_id: r.run_id, seq: r.seq, ts: iso(r.ts), level: r.level, ...(content ? { event: r.event, data: r.data } : {}) })),
    investigation_events: events.map((r) => ({ run_id: r.run_id, seq: r.seq, kind: r.kind, at: iso(r.at), ...(content ? { payload: r.payload } : {}) })),
    run_artifacts: artifacts.map((r) => ({ ...r, created_at: iso(r.created_at) })),
  };
  await appendAudit(pool, {
    actorUserId: req.actor.userId,
    actorVia: req.actor.via,
    actorRef: req.actor.ref ?? null,
    action: 'subject.export',
    targetType: 'subject',
    targetId: hashes[0]?.slice(0, 16) ?? null,
    outcome: 'success',
    meta: {
      scope: out.scope,
      content,
      values: hashes.length,
      dataset_items: out.dataset_items.length,
      runs: out.runs.length,
      run_logs: out.run_logs.length,
      investigation_events: out.investigation_events.length,
      run_artifacts: out.run_artifacts.length,
    },
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// erase_subject
// ---------------------------------------------------------------------------------------------------------------
export type EraseReport = {
  dry_run: boolean;
  subject_hashes: string[];
  plan: ErasePlan;
  dataset_items: number;
  items_scrubbed: number;
  dedup_keys: number;
  run_artifacts: number;
  scrubbed: Record<string, number>;
  exclusions_added: number;
  /** Tables de contenu où une valeur subsiste : toujours vide après un effacement validé (sinon annulation). */
  residual: Record<string, number>;
};

/**
 * Efface le sujet dans la portée. `dryRun` : plan (datasets et propriétaires touchés, comptes) et `confirmation`, rien
 * n'est écrit. Exécution : exige `confirm` = la confirmation d'un `dry_run` sur le même état ; une transaction ; ajout à
 * `subject_exclusions` ; balayage final des tables de contenu : un résidu annule tout (`SubjectErasureIncompleteError`).
 */
export async function eraseSubject(pool: pg.Pool, req: SubjectRequest, opts: { dryRun?: boolean; confirm?: string } = {}): Promise<EraseReport> {
  assertUsableSubject(req.values);
  assertScope(req);
  const dryRun = opts.dryRun ?? false;
  const hashes = subjectHashes(req.key, req.values);
  const pattern = subjectRegex(req.values)!;

  if (dryRun) {
    const items = await classifyItems(pool, req, pattern);
    const plan = buildPlan(req, items, await scrubRowCounts(pool, req, pattern));
    const report = emptyReport(true, hashes, plan);
    report.dataset_items = items.subject.length;
    report.items_scrubbed = items.mentions.length;
    report.scrubbed = plan.rows;
    await appendErasureAudit(pool, req, report);
    return report;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const items = await classifyItems(client, req, pattern);
      const plan = buildPlan(req, items, await scrubRowCounts(client, req, pattern));
      if (!opts.confirm || opts.confirm !== plan.confirmation) {
        throw new SubjectErasureNotConfirmedError(
          'effacement non confirmé : lancez d’abord un dry_run, vérifiez les datasets et propriétaires touchés, puis renvoyez sa confirmation (le plan a pu changer depuis).',
        );
      }
      const report = emptyReport(false, hashes, plan);
      // Runs liés au sujet, relevés avant toute modification : leurs artefacts (chiffrés) sont supprimés.
      const runIds = await relatedRunIds(client, req, pattern, items.subject);
      for (const r of items.subject) {
        await client.query('DELETE FROM dataset_items WHERE created_at = $1::timestamptz AND dataset_id = $2 AND seq = $3', [r.created_key, r.dataset_id, r.seq]);
      }
      report.dataset_items = items.subject.length;
      for (const r of items.mentions) {
        const scrubbed = JSON.stringify(scrubSubject(r.item, req.values));
        await client.query('UPDATE dataset_items SET item = $4::jsonb, size_bytes = $5 WHERE created_at = $1::timestamptz AND dataset_id = $2 AND seq = $3', [
          r.created_key,
          r.dataset_id,
          r.seq,
          scrubbed,
          Buffer.byteLength(scrubbed),
        ]);
      }
      report.items_scrubbed = items.mentions.length;
      const touched = plan.datasets.map((d) => d.dataset_id);
      if (touched.length > 0) {
        await client.query(
          `UPDATE datasets d SET item_count = s.n, bytes = s.b
             FROM (SELECT x.id, count(i.seq)::int AS n, coalesce(sum(i.size_bytes), 0)::bigint AS b
                     FROM unnest($1::uuid[]) AS x(id) LEFT JOIN dataset_items i ON i.dataset_id = x.id GROUP BY x.id) s
            WHERE d.id = s.id`,
          [touched],
        );
      }
      // Clés de déduplication dérivées du sujet (valeurs demandées, clés des items supprimés).
      const dedupSources = new Set([...req.values, ...items.subject.map((r) => r.dedup_key).filter((k): k is string => k !== null)]);
      const dedupHashes = [...dedupSources].map((v) => dedupKeyHash(req.key, v));
      const fd = ownerFilter(req.scope, 2);
      report.dedup_keys = (await client.query(`DELETE FROM dedup_keys WHERE key_hash = ANY($1::text[])${fd.sql}`, [dedupHashes, ...fd.params])).rowCount ?? 0;
      const fa = ownerFilter(req.scope, 2);
      report.run_artifacts = (await client.query(`DELETE FROM run_artifacts WHERE run_id = ANY($1::uuid[])${fa.sql}`, [runIds, ...fa.params])).rowCount ?? 0;
      for (const t of Object.values(SCRUB_TARGETS)) {
        const n = await scrubTable(client, t, pattern, req);
        if (n > 0) report.scrubbed[t.table] = n;
      }
      for (const h of hashes) {
        const r = await client.query('INSERT INTO subject_exclusions (subject_hash) VALUES ($1) ON CONFLICT DO NOTHING', [h]);
        report.exclusions_added += r.rowCount ?? 0;
      }
      report.residual = await countSubjectOccurrences(client, req.values, req.scope);
      if (Object.keys(report.residual).length > 0) throw new SubjectErasureIncompleteError(report.residual);
      await appendErasureAudit(client, req, report);
      await client.query('COMMIT');
      return report;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
  }
}

function emptyReport(dryRun: boolean, hashes: string[], plan: ErasePlan): EraseReport {
  return { dry_run: dryRun, subject_hashes: hashes, plan, dataset_items: 0, items_scrubbed: 0, dedup_keys: 0, run_artifacts: 0, scrubbed: {}, exclusions_added: 0, residual: {} };
}

async function scrubTable(db: Queryable, t: ScrubTarget, pattern: string, req: SubjectRequest): Promise<number> {
  const rows = await matchingRows<Record<string, unknown>>(db, t, [...t.pk, ...t.json, ...t.text], pattern, req.scope);
  for (const row of rows) {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const c of t.json) {
      if (row[c] === null || row[c] === undefined) continue;
      params.push(JSON.stringify(scrubSubject(row[c], req.values)));
      sets.push(`${c} = $${params.length}::jsonb`);
    }
    for (const c of t.text) {
      if (typeof row[c] !== 'string') continue;
      params.push(scrubSubject(row[c], req.values));
      sets.push(`${c} = $${params.length}`);
    }
    if (sets.length === 0) continue;
    const where = t.pk.map((c) => {
      params.push(row[c]);
      return `${c} = $${params.length}`;
    });
    await db.query(`UPDATE ${t.table} SET ${sets.join(', ')} WHERE ${where.join(' AND ')}`, params);
  }
  return rows.length;
}

function appendErasureAudit(db: Queryable, req: SubjectRequest, r: EraseReport): Promise<void> {
  return appendAudit(db, {
    actorUserId: req.actor.userId,
    actorVia: req.actor.via,
    actorRef: req.actor.ref ?? null,
    action: r.dry_run ? 'subject.erase_dry_run' : 'subject.erase',
    targetType: 'subject',
    targetId: r.subject_hashes[0]?.slice(0, 16) ?? null,
    outcome: 'success',
    meta: {
      scope: 'ownerId' in req.scope ? 'owner' : 'instance',
      values: r.subject_hashes.length,
      datasets: r.plan.datasets.length,
      owners: r.plan.owners.length,
      dataset_items: r.dataset_items,
      items_scrubbed: r.items_scrubbed,
      dedup_keys: r.dedup_keys,
      run_artifacts: r.run_artifacts,
      scrubbed: r.scrubbed,
      exclusions_added: r.exclusions_added,
    },
  });
}
