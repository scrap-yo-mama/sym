// Droits des personnes (RGPD art. 15 et 17 ; 17 § 6) : `export_subject`, `erase_subject`, liste d'exclusion hachée.
//
// Le sujet est désigné par des valeurs `x-personal` (e-mail, téléphone, nom…) : `resolveSubjectValues` les lit dans un
// item selon le `output_schema` de son API. Identité système (propriétaire des tables) : l'administrateur n'ouvre jamais
// le contenu d'un autre utilisateur (INV5) ; l'appelant applique la politique d'accès, ces fonctions tracent l'exécution
// dans `audit_events` (comptes et empreinte tronquée, jamais une valeur).
//
// Couverture de l'effacement (toutes en une transaction) :
//  - dataset_items : items contenant une valeur du sujet (recherche textuelle insensible à la casse, sur tout l'item) ;
//    supprimés, compteurs des datasets recalculés ;
//  - run_logs, runs (input, error_detail), investigation_events (dont les échantillons), status_events, tunnel_jobs,
//    schedules (input) : valeur remplacée par `[erased]` ;
//  - run_artifacts (chiffrés, donc illisibles) : supprimés pour tout run lié au sujet ;
//  - subject_exclusions : HMAC-SHA256 de chaque valeur normalisée, clé dérivée de MASTER_KEY (libellé `subjects`).
// Limites connues : les variantes de mise en forme d'un même téléphone ne sont pas énumérables (forme saisie, échappée et
// chiffres seuls seulement) ; `dedup_keys.key_hash` est un condensé sans valeur (non relié au sujet) ; les comptes
// utilisateurs (`users`) ne sont pas effacés : ils ressortent dans `residual`.
import { extractPersonalValues, normalizeSubjectValue, subjectHash, subjectHashes } from '@runtime/core';
import type pg from 'pg';
import { appendAudit } from '../audit.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export const ERASED = '[erased]';

export type SubjectActor = { userId: string | null; via: 'ui' | 'apikey' | 'mcp' | 'sso' | 'system'; ref?: string | null };
export type SubjectRequest = {
  /** Valeurs `x-personal` identifiant la personne. */
  values: readonly string[];
  /** Clé HMAC : `MasterKey.kek('subjects')`. */
  key: Buffer;
  actor: SubjectActor;
};

// ---------------------------------------------------------------------------------------------------------------
// Valeurs et motifs de recherche
const jsonEscape = (s: string) => JSON.stringify(s).slice(1, -1);
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const PHONE_DIGITS = /^\+?\d{6,}$/;
const PHONE_SEPARATORS = '[\\s.()-]*';

/**
 * Motifs d'expression régulière (syntaxe commune à JavaScript et aux ARE de PostgreSQL) recherchés pour chaque valeur :
 * saisie, forme échappée JSON, forme normalisée ; un téléphone est cherché chiffre à chiffre, séparateurs libres
 * (`+33 6 12…`, `06.12…`, `+33612…`), sans être collé à d'autres chiffres.
 */
export function searchForms(values: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const raw of values) {
    const v = raw.trim();
    const norm = normalizeSubjectValue(v);
    if (norm === '') continue;
    if (PHONE_DIGITS.test(norm)) {
      const digits = [...norm.replace(/\D/g, '')].join(PHONE_SEPARATORS);
      forms.add(`(?<![0-9])${norm.startsWith('+') ? `\\+${PHONE_SEPARATORS}` : ''}${digits}(?![0-9])`);
      continue;
    }
    forms.add(reEscape(v));
    forms.add(reEscape(jsonEscape(v)));
    forms.add(reEscape(norm));
  }
  return [...forms];
}

/** Motif unique (alternance) de la demande ; `null` sans valeur exploitable. */
export function subjectRegex(values: readonly string[]): string | null {
  const forms = searchForms(values);
  return forms.length ? [...forms].sort((a, b) => b.length - a.length).join('|') : null;
}

/** Valeurs `x-personal` d'un item d'un dataset, d'après le `output_schema` de son API : point de départ d'une demande. */
export async function resolveSubjectValues(db: Queryable, ref: { datasetId: string; seq: number }): Promise<string[]> {
  const { rows } = await db.query<{ item: unknown; output_schema: unknown }>(
    `SELECT i.item, a.output_schema FROM dataset_items i
       JOIN datasets d ON d.id = i.dataset_id JOIN apis a ON a.id = d.api_id
      WHERE i.dataset_id = $1 AND i.seq = $2 LIMIT 1`,
    [ref.datasetId, ref.seq],
  );
  const row = rows[0];
  return row ? extractPersonalValues(row.output_schema, row.item) : [];
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
// Parcours des tables : comptage brut (vérification) et recherche
// ---------------------------------------------------------------------------------------------------------------
async function contentTables(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND c.relname <> 'schema_migrations'
    ORDER BY 1`);
  return rows.map((r) => r.name);
}

/**
 * Nombre de lignes contenant une valeur du sujet, par table (SQL brut sur `to_jsonb(ligne)`, toutes tables du schéma
 * public). Sert à vérifier l'effacement (`residual`) et à l'évaluation `dry_run`.
 */
export async function countSubjectOccurrences(db: Queryable, values: readonly string[]): Promise<Record<string, number>> {
  const patterns = subjectRegex(values);
  const out: Record<string, number> = {};
  if (patterns === null) return out;
  for (const table of await contentTables(db)) {
    const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}" t WHERE to_jsonb(t)::text ~* $1`, [patterns]);
    const n = Number(rows[0]?.n ?? 0);
    if (n > 0) out[table] = n;
  }
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
    if (typeof v === 'number' || typeof v === 'boolean') return norms.has(normalizeSubjectValue(String(v))) ? ERASED : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x)]));
    return v;
  };
  return walk(value);
}

type ScrubTarget = { table: string; pk: string[]; json: string[]; text: string[] };
const SCRUB_TARGETS: ScrubTarget[] = [
  { table: 'run_logs', pk: ['run_id', 'seq'], json: ['data'], text: ['event'] },
  { table: 'runs', pk: ['id'], json: ['input'], text: ['error_detail'] },
  { table: 'investigation_events', pk: ['run_id', 'seq'], json: ['payload'], text: [] },
  { table: 'status_events', pk: ['id'], json: [], text: ['reason'] },
  { table: 'tunnel_jobs', pk: ['job_id'], json: ['payload', 'trace'], text: [] },
  { table: 'schedules', pk: ['id'], json: ['input'], text: [] },
];

function matchClause(t: ScrubTarget, param: string): string {
  const cols = [...t.json.map((c) => `${c}::text`), ...t.text];
  return cols.map((c) => `${c} ~* ${param}`).join(' OR ');
}

// ---------------------------------------------------------------------------------------------------------------
// export_subject
// ---------------------------------------------------------------------------------------------------------------
export type SubjectExport = {
  generated_at: string;
  /** Empreintes HMAC des valeurs demandées (les valeurs elles-mêmes ne sont pas répétées). */
  subject_hashes: string[];
  excluded: boolean;
  dataset_items: { dataset_id: string; seq: number; created_at: string; run_id: string | null; item: unknown }[];
  runs: { id: string; api_id: string; created_at: string; input: unknown; error_detail: string | null }[];
  run_logs: { run_id: string; seq: number; ts: string; level: string; event: string; data: unknown }[];
  investigation_events: { run_id: string; seq: number; kind: string; at: string; payload: unknown }[];
  run_artifacts: { id: string; run_id: string; kind: string; bytes: number; created_at: string }[];
};

async function matchingRunIds(db: Queryable, patterns: string): Promise<string[]> {
  const ids = new Set<string>();
  const add = async (sql: string) => {
    for (const r of (await db.query<{ run_id: string }>(sql, [patterns])).rows) ids.add(r.run_id);
  };
  await add(`SELECT run_id::text FROM dataset_items WHERE run_id IS NOT NULL AND (item::text ~* $1 OR dedup_key ~* $1)`);
  await add(`SELECT id::text AS run_id FROM runs WHERE ${matchClause(SCRUB_TARGETS[1]!, '$1')}`);
  await add(`SELECT run_id::text FROM run_logs WHERE ${matchClause(SCRUB_TARGETS[0]!, '$1')}`);
  await add(`SELECT run_id::text FROM investigation_events WHERE ${matchClause(SCRUB_TARGETS[2]!, '$1')}`);
  await add(`SELECT run_id::text FROM tunnel_jobs WHERE ${matchClause(SCRUB_TARGETS[4]!, '$1')}`);
  return [...ids];
}

/** JSON de ce que l'instance détient sur le sujet (art. 15). Tracé dans `audit_events`. */
export async function exportSubject(pool: pg.Pool, req: SubjectRequest, now: Date = new Date()): Promise<SubjectExport> {
  assertUsableSubject(req.values);
  const hashes = subjectHashes(req.key, req.values);
  const patterns = subjectRegex(req.values);
  const empty: SubjectExport = {
    generated_at: now.toISOString(),
    subject_hashes: hashes,
    excluded: false,
    dataset_items: [],
    runs: [],
    run_logs: [],
    investigation_events: [],
    run_artifacts: [],
  };
  let out = empty;
  if (patterns !== null) {
    const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => pool.query<T>(sql, params).then((r) => r.rows);
    const iso = (d: Date) => d.toISOString();
    const items = await q<{ dataset_id: string; seq: number; created_at: Date; run_id: string | null; item: unknown }>(
      `SELECT dataset_id, seq, created_at, run_id, item FROM dataset_items WHERE item::text ~* $1 OR dedup_key ~* $1 ORDER BY created_at, dataset_id, seq`,
      [patterns],
    );
    const runs = await q<{ id: string; api_id: string; created_at: Date; input: unknown; error_detail: string | null }>(
      `SELECT id, api_id, created_at, input, error_detail FROM runs WHERE ${matchClause(SCRUB_TARGETS[1]!, '$1')} ORDER BY created_at`,
      [patterns],
    );
    const logs = await q<{ run_id: string; seq: number; ts: Date; level: string; event: string; data: unknown }>(
      `SELECT run_id, seq, ts, level, event, data FROM run_logs WHERE ${matchClause(SCRUB_TARGETS[0]!, '$1')} ORDER BY ts`,
      [patterns],
    );
    const events = await q<{ run_id: string; seq: number; kind: string; at: Date; payload: unknown }>(
      `SELECT run_id, seq, kind, at, payload FROM investigation_events WHERE ${matchClause(SCRUB_TARGETS[2]!, '$1')} ORDER BY at`,
      [patterns],
    );
    const runIds = await matchingRunIds(pool, patterns);
    const artifacts = await q<{ id: string; run_id: string; kind: string; bytes: number; created_at: Date }>(
      `SELECT id, run_id, kind, bytes, created_at FROM run_artifacts WHERE run_id = ANY($1::uuid[]) ORDER BY created_at`,
      [runIds],
    );
    const excluded = (await q('SELECT 1 FROM subject_exclusions WHERE subject_hash = ANY($1::text[]) LIMIT 1', [hashes])).length > 0;
    out = {
      ...empty,
      excluded,
      dataset_items: items.map((r) => ({ ...r, created_at: iso(r.created_at) })),
      runs: runs.map((r) => ({ ...r, created_at: iso(r.created_at) })),
      run_logs: logs.map((r) => ({ ...r, ts: iso(r.ts) })),
      investigation_events: events.map((r) => ({ ...r, at: iso(r.at) })),
      run_artifacts: artifacts.map((r) => ({ ...r, created_at: iso(r.created_at) })),
    };
  }
  await appendAudit(pool, {
    actorUserId: req.actor.userId,
    actorVia: req.actor.via,
    actorRef: req.actor.ref ?? null,
    action: 'subject.export',
    targetType: 'subject',
    targetId: hashes[0]?.slice(0, 16) ?? null,
    outcome: 'success',
    meta: {
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
  dataset_items: number;
  run_artifacts: number;
  scrubbed: Record<string, number>;
  exclusions_added: number;
  /** Tables où une valeur subsiste encore après l'effacement (ex. `users`) : à traiter hors de cet outil. */
  residual: Record<string, number>;
};

/**
 * Efface le sujet partout (une transaction), l'ajoute à `subject_exclusions` (empreintes HMAC) puis vérifie par un
 * balayage SQL brut de toutes les tables. `dryRun` : comptes seulement, rien n'est écrit (pas même l'exclusion).
 */
export async function eraseSubject(pool: pg.Pool, req: SubjectRequest, opts: { dryRun?: boolean } = {}): Promise<EraseReport> {
  assertUsableSubject(req.values);
  const dryRun = opts.dryRun ?? false;
  const hashes = subjectHashes(req.key, req.values);
  const patterns = subjectRegex(req.values);
  const report: EraseReport = {
    dry_run: dryRun,
    subject_hashes: hashes,
    dataset_items: 0,
    run_artifacts: 0,
    scrubbed: {},
    exclusions_added: 0,
    residual: {},
  };

  if (dryRun) {
    const counts = await countSubjectOccurrences(pool, req.values);
    report.dataset_items = counts['dataset_items'] ?? 0;
    report.residual = counts;
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (patterns !== null) {
        // Runs liés au sujet, relevés avant toute modification : leurs artefacts (chiffrés) sont supprimés.
        const runIds = await matchingRunIds(client, patterns);
        const deleted = await client.query<{ dataset_id: string }>(
          `DELETE FROM dataset_items WHERE item::text ~* $1 OR dedup_key ~* $1 RETURNING dataset_id`,
          [patterns],
        );
        report.dataset_items = deleted.rowCount ?? 0;
        const touched = [...new Set(deleted.rows.map((r) => r.dataset_id))];
        if (touched.length > 0) {
          await client.query(
            `UPDATE datasets d SET item_count = s.n, bytes = s.b
               FROM (SELECT x.id, count(i.seq)::int AS n, coalesce(sum(i.size_bytes), 0)::bigint AS b
                       FROM unnest($1::uuid[]) AS x(id) LEFT JOIN dataset_items i ON i.dataset_id = x.id GROUP BY x.id) s
              WHERE d.id = s.id`,
            [touched],
          );
        }
        const artifacts = await client.query('DELETE FROM run_artifacts WHERE run_id = ANY($1::uuid[])', [runIds]);
        report.run_artifacts = artifacts.rowCount ?? 0;
        for (const target of SCRUB_TARGETS) report.scrubbed[target.table] = await scrubTable(client, target, patterns, req.values);
      }
      for (const h of hashes) {
        const r = await client.query('INSERT INTO subject_exclusions (subject_hash) VALUES ($1) ON CONFLICT DO NOTHING', [h]);
        report.exclusions_added += r.rowCount ?? 0;
      }
      report.residual = await countSubjectOccurrences(client, req.values);
      await appendErasureAudit(client, req, report);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return report;
  }
  await appendErasureAudit(pool, req, report);
  return report;
}

async function scrubTable(db: Queryable, t: ScrubTarget, patterns: string, values: readonly string[]): Promise<number> {
  const cols = [...t.json, ...t.text];
  const { rows } = await db.query<Record<string, unknown>>(`SELECT ${[...t.pk, ...cols].join(', ')} FROM ${t.table} WHERE ${matchClause(t, '$1')}`, [patterns]);
  for (const row of rows) {
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const c of t.json) {
      if (row[c] === null || row[c] === undefined) continue;
      params.push(JSON.stringify(scrubSubject(row[c], values)));
      sets.push(`${c} = $${params.length}::jsonb`);
    }
    for (const c of t.text) {
      if (typeof row[c] !== 'string') continue;
      params.push(scrubSubject(row[c], values));
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
      values: r.subject_hashes.length,
      dataset_items: r.dataset_items,
      run_artifacts: r.run_artifacts,
      scrubbed: r.scrubbed,
      exclusions_added: r.exclusions_added,
      residual_tables: Object.keys(r.residual),
    },
  });
}

/** Refuse une demande sans valeur exploitable ou avec une valeur trop courte (« al » effacerait « Alice » et « Alain »). */
export const MIN_SUBJECT_VALUE_LENGTH = 4;
export function assertUsableSubject(values: readonly string[]): void {
  const usable = values.filter((v) => normalizeSubjectValue(v).length >= MIN_SUBJECT_VALUE_LENGTH);
  if (usable.length === 0 || usable.length !== values.filter((v) => normalizeSubjectValue(v) !== '').length) {
    throw new Error(`sujet refusé : au moins une valeur, et chacune d'au moins ${MIN_SUBJECT_VALUE_LENGTH} caractères.`);
  }
}
