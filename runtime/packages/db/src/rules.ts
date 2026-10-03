// SPDX-License-Identifier: AGPL-3.0-only
// Règles, consignes et skills Markdown (tâche 2.10, 18 §4, migration 0019) : service partagé par la console, REST et MCP
// (routes, outils et écran : tâche 3.13). Toutes les lectures et écritures passent par `withActor` (RLS, INV12).
// - Enregistrement : format fermé (`invalid_rule`, 422), version par contenu (même contenu : même version ; version
//   fournie et périmée : `version_conflict`, 409), `widening_warnings` (le fichier est enregistré, la protection est le
//   code), `api:<slug>` résolu en `api_id` d'une API DU PROPRIÉTAIRE du fichier (sinon 422).
// - Écritures d'instance (consignes, partage, `escalade-par-defaut.md` et tout fichier d'instance) : admin en SESSION
//   CONSOLE seulement ; toute clé d'API ou appel MCP, admin compris, reçoit `insufficient_scope` (403), un membre
//   `forbidden` (403) ; chaque refus est un événement d'audit `denied`. Un nom égal à celui d'un fichier d'instance désigne
//   ce fichier (aucune copie privée qui l'ombrerait).
// - Origines `mcp` et `import` : version « à relire » forcée par la base ; la résolution garde la dernière version
//   confirmée ; seule la console confirme (`human_confirmation_required` sinon). Recopier une proposition en attente
//   (même forme canonique : espaces, lignes vides et `version` sans effet) : `human_confirmation_required`.
// - Audit (13 §9) : `rule.created`, `rule.updated`, `rule.shared`, `rule.unshared`, `rule.imported`,
//   `instance_directive.updated`, `rule.confirmed`, `recompile.requested`, avec `nom@version` et `sha256`, jamais le contenu.
// - Recompilation (18 §4.8) : propriétaire de l'API seulement (404 uniforme), une seule à la fois
//   (`recompile_in_progress`), transition 19 ou 20 raison `rules_changed`, schéma de sortie conservé.
import {
  parseEmbeddedRef,
  parseRuleFile,
  resolveRules,
  ruleCanonical,
  RuleFormatError,
  RULES_MAX_TOKENS,
  sourceRules,
  wideningWarnings,
  type JobQueue,
  type ResolvedRules,
  type Role,
  type RuleCandidate,
  type RuleKind,
  type RuleLevel,
  type RulesBudgetRole,
  type RunTrigger,
  type EmbeddedFile,
  type StrategyRuleRow,
  type StrategySource,
  type WideningWarning,
} from '@runtime/core';
import { INVESTIGATION_DEFAULTS } from '@runtime/core/investigation';
import type pg from 'pg';
import { appendAudit, type AuditEvent } from './audit.js';
import type { InvestigationState } from './investigations.js';
import { applyStatusAndNotify } from './notify.js';
import { asActorInTransaction, withActor } from './rls.js';
import { createRun } from './runs.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** Canal de l'écriture : session console, clé d'API (REST), MCP, import (console). */
export type RuleChannel = 'console' | 'api_key' | 'mcp' | 'import';
export type RuleActor = { readonly userId: string; readonly role: Role; readonly via: RuleChannel };
export type RuleReader = { readonly userId: string; readonly role: Role };

export type RuleServiceCode = 'invalid_rule' | 'insufficient_scope' | 'forbidden' | 'version_conflict' | 'human_confirmation_required' | 'not_found' | 'recompile_in_progress' | 'not_recompilable';
const STATUS: Readonly<Record<RuleServiceCode, number>> = {
  invalid_rule: 422,
  insufficient_scope: 403,
  forbidden: 403,
  human_confirmation_required: 403,
  version_conflict: 409,
  not_found: 404,
  recompile_in_progress: 409,
  not_recompilable: 409,
};

export class RuleServiceError extends Error {
  readonly code: RuleServiceCode;
  readonly status: number;
  constructor(code: RuleServiceCode, message: string) {
    super(message);
    this.name = 'RuleServiceError';
    this.code = code;
    this.status = STATUS[code];
  }
}

const ORIGIN: Readonly<Record<RuleChannel, string>> = { console: 'ui', api_key: 'rest', mcp: 'mcp', import: 'import' };
const AUDIT_VIA: Readonly<Record<RuleChannel, AuditEvent['actorVia']>> = { console: 'ui', api_key: 'apikey', mcp: 'mcp', import: 'ui' };
const isAdmin = (role: Role) => role === 'admin' || role === 'owner';

export type PutRuleResult = {
  readonly id: string;
  readonly name: string;
  readonly kind: RuleKind;
  readonly visibility: 'private' | 'instance';
  readonly version: number;
  /** Faux : contenu identique à la dernière version, aucune version créée. */
  readonly created: boolean;
  readonly review_state: 'none' | 'to_review' | 'confirmed';
  readonly widening_warnings: readonly WideningWarning[];
};

type FileRow = { id: string; owner_id: string | null; kind: RuleKind; name: string; visibility: 'private' | 'instance'; current_version: number };

async function auditDenied(pool: pg.Pool, actor: RuleActor, action: string, meta: Record<string, unknown>): Promise<void> {
  await withActor(pool, { userId: actor.userId, role: actor.role }, (tx) =>
    appendAudit(tx, { actorUserId: actor.userId, actorVia: AUDIT_VIA[actor.via], action, targetType: 'rule', outcome: 'denied', meta }),
  ).catch(() => undefined);
}

/** Enregistre un fichier (création ou nouvelle version). Lève `RuleServiceError`. */
export async function putRule(pool: pg.Pool, actor: RuleActor, input: { readonly content: string; readonly visibility?: 'private' | 'instance' }): Promise<PutRuleResult> {
  let doc;
  try {
    doc = parseRuleFile(input.content);
  } catch (error) {
    if (error instanceof RuleFormatError) throw new RuleServiceError('invalid_rule', error.detail);
    throw error;
  }
  const denied = async (code: 'insufficient_scope' | 'forbidden', why: string): Promise<never> => {
    await auditDenied(pool, actor, doc.kind === 'instance' ? 'instance_directive.updated' : 'rule.updated', { name: doc.name, kind: doc.kind, reason: why });
    throw new RuleServiceError(code, why);
  };
  // Fichier visé : celui d'instance du même nom s'il existe (jamais d'ombre privée), sinon celui de l'acteur.
  const existing = await withActor(pool, { userId: actor.userId, role: actor.role }, async (tx) => {
    const { rows } = await tx.query<FileRow>(
      `SELECT id, owner_id, kind, name, visibility, current_version FROM rule_files
       WHERE kind = $1 AND name = $2 AND deleted_at IS NULL AND (owner_id IS NULL OR owner_id = $3)
       ORDER BY (owner_id IS NULL) DESC LIMIT 1`,
      [doc.kind, doc.name, actor.userId],
    );
    return rows[0] ?? null;
  });
  const visibility: 'private' | 'instance' = doc.kind === 'instance' ? 'instance' : (input.visibility ?? existing?.visibility ?? 'private');
  const instanceWrite = doc.kind === 'instance' || visibility === 'instance' || existing?.visibility === 'instance';
  if (instanceWrite) {
    // 18 §4.6 : jamais par une clé d'API ni par MCP, admin compris ; en console (ou import en console) : admin seulement.
    if (actor.via === 'api_key' || actor.via === 'mcp') return denied('insufficient_scope', 'écriture d’instance : session console d’un admin seulement');
    if (!isAdmin(actor.role)) return denied('forbidden', 'écriture d’instance : admin seulement');
  }
  // `api:<slug>` : API du propriétaire du fichier seulement, résolue par identifiant.
  const fileOwner = instanceWrite && (doc.kind === 'instance' || existing?.owner_id === null) ? null : (existing?.owner_id ?? actor.userId);
  // Un fichier installé pour l'instance (sans propriétaire) reste d'instance : il se modifie ou se réinitialise, jamais ne se privatise.
  if (fileOwner === null && visibility !== 'instance') throw new RuleServiceError('invalid_rule', 'fichier d’instance : visibility instance obligatoire');
  const slugs = doc.applies_to.filter((s) => s.startsWith('api:')).map((s) => s.slice(4));
  const targetIds: string[] = [];
  if (slugs.length > 0) {
    if (fileOwner === null) throw new RuleServiceError('invalid_rule', 'api:<slug> interdit dans un fichier d’instance');
    const found = await withActor(pool, { userId: actor.userId, role: actor.role }, (tx) =>
      tx.query<{ id: string; slug: string }>('SELECT id, slug FROM apis WHERE owner_id = $1 AND slug = ANY($2::text[])', [fileOwner, slugs]),
    );
    for (const slug of slugs) {
      const row = found.rows.find((r) => r.slug === slug);
      if (row === undefined) throw new RuleServiceError('invalid_rule', `api:${slug} : aucune API de ce nom chez le propriétaire du fichier`);
      targetIds.push(row.id);
    }
  }
  const widening = wideningWarnings(`${doc.description}\n${doc.body}`);
  const origin = ORIGIN[actor.via];

  return withActor(pool, { userId: actor.userId, role: actor.role }, async (tx) => {
    // Recopie d'une proposition en attente (19 §5) : jamais sans acte humain en console.
    // Comparaison sur la forme canonique (espaces, lignes vides, `version` sans effet) : une quasi-copie est une recopie.
    // Contrôle provisoire ; 2.11 et 3.13 marquent en base les versions dérivées d'une proposition.
    const pending = await tx.query<{ sha256: string; content: string }>("SELECT sha256, content FROM rule_file_versions WHERE origin IN ('proposal', 'optimizer') AND review_state = 'to_review'");
    const canonical = ruleCanonical(doc.content);
    const copies = (p: { sha256: string; content: string }) => {
      if (p.sha256 === doc.sha256) return true;
      try {
        return ruleCanonical(p.content) === canonical;
      } catch {
        return false;
      }
    };
    if (pending.rows.some(copies)) throw new RuleServiceError('human_confirmation_required', 'cette règle recopie une proposition en attente : à accepter en console');
    let file: FileRow;
    if (existing === null) {
      const inserted = await tx.query<FileRow>(
        `INSERT INTO rule_files (owner_id, kind, name, description, applies_to, target_api_ids, visibility, current_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0) RETURNING id, owner_id, kind, name, visibility, current_version`,
        [fileOwner, doc.kind, doc.name, doc.description, doc.applies_to, targetIds, visibility],
      );
      file = inserted.rows[0]!;
    } else {
      const locked = await tx.query<FileRow>('SELECT id, owner_id, kind, name, visibility, current_version FROM rule_files WHERE id = $1 FOR UPDATE', [existing.id]);
      file = locked.rows[0]!;
    }
    const last = await tx.query<{ version: number; sha256: string; review_state: PutRuleResult['review_state'] }>(
      'SELECT version, sha256, review_state FROM rule_file_versions WHERE rule_file_id = $1 ORDER BY version DESC LIMIT 1',
      [file.id],
    );
    const latest = last.rows[0];
    if (latest !== undefined && latest.sha256 === doc.sha256 && file.visibility === visibility) {
      return { id: file.id, name: file.name, kind: file.kind, visibility, version: latest.version, created: false, review_state: latest.review_state, widening_warnings: widening };
    }
    if (doc.version !== null && latest !== undefined && doc.version !== latest.version) throw new RuleServiceError('version_conflict', `version ${doc.version} périmée (courante : ${latest.version})`);
    const version = (latest?.version ?? 0) + 1;
    const ins = await tx.query<{ review_state: PutRuleResult['review_state'] }>(
      `INSERT INTO rule_file_versions (rule_file_id, version, content, sha256, description, applies_to, target_api_ids, author_id, origin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING review_state`,
      [file.id, version, doc.content, doc.sha256, doc.description, doc.applies_to, targetIds, actor.userId, origin],
    );
    await tx.query('UPDATE rule_files SET description = $2, applies_to = $3, target_api_ids = $4, visibility = $5, current_version = $6, updated_at = now() WHERE id = $1', [
      file.id,
      doc.description,
      doc.applies_to,
      targetIds,
      visibility,
      version,
    ]);
    const ref = `${doc.name}@${version}`;
    const action =
      actor.via === 'import'
        ? 'rule.imported'
        : doc.kind === 'instance'
          ? 'instance_directive.updated'
          : existing === null
            ? 'rule.created'
            : file.visibility !== visibility
              ? visibility === 'instance'
                ? 'rule.shared'
                : 'rule.unshared'
              : 'rule.updated';
    await appendAudit(tx, { actorUserId: actor.userId, actorVia: AUDIT_VIA[actor.via], action, targetType: 'rule', targetId: file.id, outcome: 'success', meta: { ref, sha256: doc.sha256, kind: doc.kind, visibility } });
    return { id: file.id, name: file.name, kind: file.kind, visibility, version, created: true, review_state: ins.rows[0]!.review_state, widening_warnings: widening };
  });
}

export type RuleView = {
  readonly id: string;
  readonly name: string;
  readonly kind: RuleKind;
  readonly visibility: 'private' | 'instance';
  readonly description: string;
  readonly applies_to: readonly string[];
  readonly current_version: number;
  readonly versions: readonly { readonly version: number; readonly sha256: string; readonly origin: string; readonly review_state: string; readonly created_at: Date }[];
  readonly content: string;
};

/** Un fichier visible de l'appelant (le sien, ou d'instance) ; `null` sinon (404 uniforme). */
export async function getRule(pool: pg.Pool, reader: RuleReader, id: string): Promise<RuleView | null> {
  return withActor(pool, reader, async (tx) => {
    const { rows } = await tx.query<Omit<RuleView, 'versions' | 'content'>>(
      'SELECT id, name, kind, visibility, description, applies_to, current_version FROM rule_files WHERE id = $1 AND deleted_at IS NULL',
      [id],
    );
    const file = rows[0];
    if (file === undefined) return null;
    const versions = await tx.query<RuleView['versions'][number] & { content: string }>(
      'SELECT version, sha256, origin, review_state, created_at, content FROM rule_file_versions WHERE rule_file_id = $1 ORDER BY version',
      [id],
    );
    return { ...file, versions: versions.rows.map(({ content: _c, ...v }) => v), content: versions.rows.at(-1)?.content ?? '' };
  });
}

/** Confirmation d'une version « à relire » : session console seulement (acte humain, 18 §4.9). */
export async function confirmRuleVersion(pool: pg.Pool, actor: RuleActor, input: { readonly id: string; readonly version: number }): Promise<void> {
  if (actor.via !== 'console') throw new RuleServiceError('human_confirmation_required', 'confirmation d’une règle : en console seulement');
  await withActor(pool, { userId: actor.userId, role: actor.role }, async (tx) => {
    const { rows } = await tx.query<{ name: string; sha256: string }>(
      `UPDATE rule_file_versions v SET review_state = 'confirmed', confirmed_by = $3, confirmed_at = now()
       FROM rule_files f WHERE f.id = v.rule_file_id AND v.rule_file_id = $1 AND v.version = $2 AND v.review_state = 'to_review'
       RETURNING f.name, v.sha256`,
      [input.id, input.version, actor.userId],
    );
    const row = rows[0];
    if (row === undefined) throw new RuleServiceError('not_found', 'version à relire introuvable');
    await appendAudit(tx, { actorUserId: actor.userId, actorVia: 'ui', action: 'rule.confirmed', targetType: 'rule', targetId: input.id, outcome: 'success', meta: { ref: `${row.name}@${input.version}`, sha256: row.sha256 } });
  });
}

/**
 * API concernées par une règle (18 §4.8) : API DE L'APPELANT dont la version courante a cette règle dans sa source ; l'admin
 * voit en plus un compte agrégé des API des autres (sans slug ni api_id). `null` si la règle n'est pas visible.
 */
export async function apisUsingRule(
  pool: pg.Pool,
  reader: RuleReader,
  ruleId: string,
): Promise<{ readonly apis: readonly { readonly api_id: string; readonly slug: string; readonly rule_version: number; readonly current_rule_version: number }[]; readonly others_count?: number } | null> {
  return withActor(pool, reader, async (tx) => {
    const file = await tx.query<{ current_version: number }>('SELECT current_version FROM rule_files WHERE id = $1 AND deleted_at IS NULL', [ruleId]);
    if (file.rows[0] === undefined) return null;
    const { rows } = await tx.query<{ api_id: string; slug: string; rule_version: number }>(
      `SELECT a.id AS api_id, a.slug, s.rule_version FROM strategy_version_rules s
       JOIN apis a ON a.id = s.api_id AND a.current_strategy_version = s.strategy_version
       WHERE s.rule_file_id = $1 AND a.owner_id = $2 AND s.owner_id = $2 AND s.loaded <> 'truncated'
       ORDER BY a.slug`,
      [ruleId, reader.userId],
    );
    const apis = rows.map((r) => ({ ...r, current_rule_version: file.rows[0]!.current_version }));
    if (!isAdmin(reader.role)) return { apis };
    const agg = await tx.query<{ apis: number }>('SELECT apis FROM admin_rule_usage WHERE rule_file_id = $1', [ruleId]);
    return { apis, others_count: Math.max(0, (agg.rows[0]?.apis ?? 0) - apis.length) };
  });
}

/** Hôte de l'API : page de la demande d'enquête, sinon URL de la stratégie courante. */
function hostOf(investigation: Partial<InvestigationState> | null, spec: Record<string, unknown> | null): string | null {
  const candidates = [
    investigation?.request?.url,
    (spec?.['request'] as { url?: unknown } | undefined)?.url,
    spec?.['start_url'],
  ];
  for (const url of candidates) {
    if (typeof url !== 'string') continue;
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      // URL illisible : suivante.
    }
  }
  return null;
}

/** Fichiers candidats d'un propriétaire : les siens et ceux d'instance, à leur dernière version confirmée ou sans relecture. */
async function ruleCandidates(tx: Queryable, ownerId: string): Promise<RuleCandidate[]> {
  const { rows } = await tx.query<RuleCandidate & { reads: string }>(
    `SELECT f.id AS file_id, f.owner_id, f.visibility, f.kind, f.name, v.description, v.applies_to, v.target_api_ids, v.version, v.sha256, v.content,
       (SELECT count(*) FROM strategy_version_rules s WHERE s.rule_file_id = f.id AND s.loaded = 'skill_read') AS reads
     FROM rule_files f
     JOIN LATERAL (
       SELECT version, sha256, content, description, applies_to, target_api_ids FROM rule_file_versions
       WHERE rule_file_id = f.id AND review_state IN ('none', 'confirmed') ORDER BY version DESC LIMIT 1
     ) v ON true
     WHERE f.deleted_at IS NULL AND (f.owner_id = $1 OR f.visibility = 'instance')`,
    [ownerId],
  );
  return rows.map((r) => ({ ...r, reads: Number(r.reads) }));
}

export type ApiRules = { readonly resolved: ResolvedRules; readonly host: string };

/** Ensemble résolu pour une API (lu comme son propriétaire) ; plafond selon l'usage (`investigate`, `repair`, `embedded`). */
export async function resolveRulesForApi(pool: pg.Pool, args: { readonly apiId: string; readonly ownerId: string; readonly role: RulesBudgetRole; readonly host?: string }): Promise<ApiRules> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const api = await tx.query<{ investigation: Partial<InvestigationState> | null; spec: Record<string, unknown> | null }>(
      `SELECT a.investigation, s.spec FROM apis a LEFT JOIN strategy_versions s ON s.api_id = a.id AND s.version = a.current_strategy_version WHERE a.id = $1 AND a.owner_id = $2`,
      [args.apiId, args.ownerId],
    );
    const row = api.rows[0];
    const host = args.host ?? (row === undefined ? null : hostOf(row.investigation, row.spec)) ?? '';
    const resolved = resolveRules(await ruleCandidates(tx, args.ownerId), { id: args.apiId, host, ownerId: args.ownerId }, { maxTokens: RULES_MAX_TOKENS[args.role] });
    return { resolved, host };
  });
}

export type ResolvedRulesView = {
  readonly role: RulesBudgetRole;
  readonly budget_tokens: number;
  readonly tokens: number;
  readonly rules: readonly { readonly name: string; readonly version: number; readonly level: RuleLevel; readonly tokens: number; readonly sha256: string }[];
  readonly skills: readonly { readonly name: string; readonly version: number; readonly description: string | null; readonly sha256: string }[];
  readonly truncated: readonly { readonly name: string; readonly version: number; readonly level: RuleLevel; readonly tokens: number }[];
  readonly skills_listing_truncated: boolean;
  readonly skills_tokens: number;
};

/** Aperçu `GET /api/apis/{slug}/resolved-rules?role=` (19 §2, 19b §2) : propriétaire seul, `null` sinon (404 uniforme). */
export async function resolvedRulesPreview(pool: pg.Pool, args: { readonly userId: string; readonly slug: string; readonly role: RulesBudgetRole }): Promise<ResolvedRulesView | null> {
  const api = await withActor(pool, { userId: args.userId, role: 'member' }, (tx) => tx.query<{ id: string }>('SELECT id FROM apis WHERE slug = $1 AND owner_id = $2', [args.slug, args.userId]));
  const id = api.rows[0]?.id;
  if (id === undefined) return null;
  const { resolved } = await resolveRulesForApi(pool, { apiId: id, ownerId: args.userId, role: args.role });
  const without = new Set(resolved.skillsWithoutDescription);
  return {
    role: args.role,
    budget_tokens: resolved.budget.rules,
    tokens: resolved.tokens,
    rules: resolved.rules.map((r) => ({ name: r.name, version: r.version, level: r.level, tokens: r.tokens, sha256: r.sha256 })),
    skills: resolved.skills.map((s) => ({ name: s.name, version: s.version, description: without.has(s.name) ? null : s.description, sha256: s.sha256 })),
    truncated: resolved.truncated.map((r) => ({ name: r.name, version: r.version, level: r.level, tokens: r.tokens })),
    skills_listing_truncated: resolved.skillsListingTruncated,
    skills_tokens: resolved.skillsTokens,
  };
}

/** Écrit la source d'une version (dans la transaction qui crée la version, comme le propriétaire). */
export async function recordStrategySource(
  tx: Queryable,
  args: { readonly apiId: string; readonly ownerId: string; readonly version: number; readonly source: StrategySource; readonly rules: readonly StrategyRuleRow[] },
): Promise<void> {
  await tx.query('UPDATE strategy_versions SET source = $3::jsonb WHERE api_id = $1 AND version = $2', [args.apiId, args.version, JSON.stringify(args.source)]);
  for (const r of args.rules) {
    await tx.query(
      `INSERT INTO strategy_version_rules (api_id, strategy_version, owner_id, rule_file_id, rule_version, sha256, level, loaded)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (api_id, strategy_version, rule_file_id) DO NOTHING`,
      [args.apiId, args.version, args.ownerId, r.rule_file_id, r.version, r.sha256, r.level, r.loaded],
    );
  }
}

/** Source d'une version et ses lignes de règles (propriétaire seul ; `null` sinon). */
export async function readStrategySource(
  pool: pg.Pool,
  args: { readonly apiId: string; readonly ownerId: string; readonly version: number },
): Promise<{ readonly source: StrategySource; readonly rules: readonly (StrategyRuleRow & { readonly name: string })[] } | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const v = await tx.query<{ source: StrategySource | null }>('SELECT source FROM strategy_versions WHERE api_id = $1 AND version = $2 AND owner_id = $3', [args.apiId, args.version, args.ownerId]);
    const row = v.rows[0];
    if (row === undefined || row.source === null) return null;
    const rules = await tx.query<StrategyRuleRow & { name: string }>(
      `SELECT s.rule_file_id, f.name, s.rule_version AS version, s.sha256, s.level, s.loaded FROM strategy_version_rules s JOIN rule_files f ON f.id = s.rule_file_id
       WHERE s.api_id = $1 AND s.strategy_version = $2 ORDER BY f.name`,
      [args.apiId, args.version],
    );
    return { source: row.source, rules: rules.rows };
  });
}

/**
 * Fichiers référencés par une stratégie E4-E6 (`spec.rules`, `nom@version#sha256`, 18 §4.5) : lus dans `rule_file_versions`
 * SOUS L'IDENTITÉ DU PROPRIÉTAIRE de l'API (RLS : ses fichiers et ceux partagés d'instance, jamais ceux d'un autre), à la
 * version et à l'empreinte référencées, jamais la version courante. Le texte est reconstruit et vérifié par le cœur
 * (`renderEmbeddedRules`) : une référence introuvable n'injecte rien.
 */
export async function readEmbeddedFiles(pool: pg.Pool, args: { readonly ownerId: string; readonly refs: readonly string[] }): Promise<EmbeddedFile[]> {
  const parsed = args.refs.map(parseEmbeddedRef).filter((r): r is NonNullable<typeof r> => r !== null);
  if (parsed.length === 0) return [];
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<EmbeddedFile>(
      `SELECT f.name, f.kind, v.version, v.sha256, v.content, v.description FROM rule_file_versions v JOIN rule_files f ON f.id = v.rule_file_id
       JOIN unnest($2::text[], $3::int[], $4::text[]) AS r(name, version, sha256) ON r.name = f.name AND r.version = v.version AND r.sha256 = v.sha256
       WHERE f.owner_id = $1 OR f.visibility = 'instance'`,
      [args.ownerId, parsed.map((r) => r.name), parsed.map((r) => r.version), parsed.map((r) => r.sha256)],
    );
    return rows;
  });
}

/**
 * Recompilation à la demande (18 §4.8) : propriétaire de l'API seulement (`not_found` sinon, 404 uniforme), une seule en
 * cours (`recompile_in_progress`). Ré-enquête : transition 19 ou 20 (raison `rules_changed`), puis run d'enquête dont le
 * schéma de sortie est celui de l'API (conservé ; un changement de schéma passe par un brouillon). Le run est compté dans
 * `investigation_budget_usd`, `max_cost_usd` et `budget_daily_usd` comme toute enquête.
 */
export async function requestRecompile(
  pool: pg.Pool,
  queue: JobQueue,
  args: { readonly userId: string; readonly slug: string; readonly trigger: RunTrigger },
): Promise<{ runId: string; jobId: string }> {
  const api = await withActor(pool, { userId: args.userId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ id: string; status: string; output_schema: unknown; investigation: Partial<InvestigationState> | null; spec: Record<string, unknown> | null; current_strategy_version: number | null }>(
      `SELECT a.id, a.status, a.output_schema, a.investigation, a.current_strategy_version, s.spec FROM apis a
       LEFT JOIN strategy_versions s ON s.api_id = a.id AND s.version = a.current_strategy_version
       WHERE a.slug = $1 AND a.owner_id = $2`,
      [args.slug, args.userId],
    );
    const row = rows[0];
    if (row === undefined) throw new RuleServiceError('not_found', 'API introuvable');
    const active = await tx.query("SELECT 1 FROM runs WHERE api_id = $1 AND kind = 'investigation' AND state IN ('queued', 'running', 'waiting_tunnel') LIMIT 1", [row.id]);
    if ((active.rowCount ?? 0) > 0 || row.status === 'enquete') throw new RuleServiceError('recompile_in_progress', 'une recompilation ou une enquête est déjà en cours sur cette API');
    return row;
  });
  const specUrl = api.spec === null ? undefined : [(api.spec['request'] as { url?: unknown } | undefined)?.url, api.spec['start_url']].find((u): u is string => typeof u === 'string');
  const url = api.investigation?.request?.url ?? specUrl;
  if (url === undefined || api.current_strategy_version === null) throw new RuleServiceError('not_recompilable', 'aucune source à recompiler (ni demande d’enquête, ni stratégie courante)');
  // La machine à états est le verrou : une seconde demande concurrente trouve l'API en `enquete` et est refusée. La
  // transition, la demande d'enquête et le run partent au MÊME COMMIT (crochet `afterWrite`) : un échec de mise en file
  // laisse l'API dans son statut, jamais en `enquete` sans run.
  const previous = api.investigation?.request;
  const state: InvestigationState = {
    request: {
      url,
      description: previous?.description ?? 'recompile',
      auto_validate: true,
      // Sans demande enregistrée : plafonds par défaut de l'enquête (`investigation_budget_usd`, `investigation_timeout_s`).
      budget_usd: previous?.budget_usd ?? INVESTIGATION_DEFAULTS.budgetUsd,
      timeout_s: previous?.timeout_s ?? INVESTIGATION_DEFAULTS.timeoutSeconds,
    },
    reason: 'recompile',
    validated_schema: api.output_schema as Record<string, unknown>,
    validated_by: 'user',
    spent_usd: 0,
    elapsed_ms: 0,
  };
  let started: { runId: string; jobId: string } | undefined;
  const step = await applyStatusAndNotify(pool, queue, {
    apiId: api.id,
    event: { type: 'reinvestigate', trigger: 'rules_changed' },
    clock: { now: () => new Date() },
    afterWrite: async (client) => {
      started = await asActorInTransaction(client, { userId: args.userId, role: 'member' }, async (tx) => {
        await tx.query("UPDATE apis SET investigation = $2::jsonb, investigation_phase = 'access_check', updated_at = now() WHERE id = $1 AND owner_id = $3", [api.id, JSON.stringify(state), args.userId]);
        await appendAudit(tx, { actorUserId: args.userId, actorVia: args.trigger === 'mcp' ? 'mcp' : args.trigger === 'rest' ? 'apikey' : 'ui', action: 'recompile.requested', targetType: 'api', targetId: api.id, outcome: 'success', meta: { slug: args.slug } });
        return createRun(tx, queue, { apiId: api.id, ownerId: args.userId, trigger: args.trigger, kind: 'investigation' });
      });
    },
  });
  if (!step.ok) throw new RuleServiceError(step.state.status === 'enquete' ? 'recompile_in_progress' : 'not_recompilable', `recompilation refusée depuis ce statut (${step.rejected})`);
  return started!;
}

/**
 * Ce que vN+1 reprend de la source de vN (réparation, 18 §2 : « recompiler depuis la source ») : la demande et les
 * décisions de l'enquête. À défaut de source sur vN (version d'avant 2.10, importée), la demande d'enquête de l'API.
 * Propriétaire seul ; `null` sinon.
 */
export async function readSourceBase(
  pool: pg.Pool,
  args: { readonly apiId: string; readonly ownerId: string; readonly version: number },
): Promise<{ readonly request: StrategySource['request']; readonly decisions: readonly string[]; readonly investigation_id: string | null } | null> {
  return withActor(pool, { userId: args.ownerId, role: 'member' }, async (tx) => {
    const { rows } = await tx.query<{ source: StrategySource | null; investigation: Partial<InvestigationState> | null }>(
      'SELECT s.source, a.investigation FROM apis a LEFT JOIN strategy_versions s ON s.api_id = a.id AND s.version = $3 WHERE a.id = $1 AND a.owner_id = $2',
      [args.apiId, args.ownerId, args.version],
    );
    const row = rows[0];
    if (row === undefined) return null;
    if (row.source !== null) return { request: row.source.request, decisions: row.source.decisions, investigation_id: row.source.investigation_id };
    const request = row.investigation?.request;
    if (request === undefined) return null;
    return { request: { description: request.description, url: request.url, example_output_ref: null }, decisions: [], investigation_id: null };
  });
}

/** Source d'une enquête, d'une réparation ou d'une recompilation (18 §4.6). */
export function buildStrategySource(args: {
  readonly reason: StrategySource['reason'];
  readonly description: string;
  readonly url: string;
  readonly outputSchemaSha256: string;
  readonly investigationId: string | null;
  readonly decisions?: readonly string[];
  readonly rows: readonly StrategyRuleRow[];
  readonly exampleOutputRef?: string | null;
}): StrategySource {
  return {
    request: { description: args.description, url: args.url, example_output_ref: args.exampleOutputRef ?? null },
    output_schema_sha256: args.outputSchemaSha256,
    investigation_id: args.investigationId,
    decisions: [...(args.decisions ?? [])],
    rules: sourceRules(args.rows),
    reason: args.reason,
  };
}

