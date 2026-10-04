// SPDX-License-Identifier: AGPL-3.0-only
// Service du dossier d'enquête côté serveur (tâche 2.14, 19c § 2, § 4, § 7 ; D-83) : reçoit le dossier de `create_api`
// (MCP) et de `POST /api/apis` (REST), le contrôle AVANT toute création (taille, schéma fermé, secrets : rien n'est créé sur
// une erreur, la valeur fautive n'est jamais renvoyée), le normalise et le masque (couches 1 et 2, liste d'exclusion des
// personnes effacées) puis l'enregistre en version immuable dans la transaction de création. Le rapport (`brief_report[]`)
// et le récit (`narrative.brief.*`) ne portent que des faits du code : identifiants, types, états, gabarits reconstruits.
import {
  briefNarrative,
  briefReport,
  buildBriefDigest,
  checkBrief,
  DEFAULT_BRIEF_CONFIG,
  finalizeBriefHints,
  normalizeBrief,
  type BriefConfig,
  type BriefRejection,
  type BriefReportEntry,
  type FinalHint,
  type InvestigationBrief,
  type NarrativeLocale,
} from '@runtime/core';
import { siteScope } from '@runtime/core/investigation';
import { isUsableSubjectValue, subjectHash } from '@runtime/core';
import { loadSubjectExclusions, loadSubjectKey, readHintOutcomes, readLatestBrief, storeBrief } from '@runtime/db';
import type pg from 'pg';
import type { ServerContext } from '../context.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

const briefConfigOf = (ctx: ServerContext): BriefConfig => ctx.brief ?? DEFAULT_BRIEF_CONFIG;

/** Contrôle d'entrée (19c § 9.3) : `null` si le dossier est acceptable, sinon le refus (code, champ, conduite). */
export function rejectBrief(ctx: ServerContext, raw: unknown): BriefRejection | null {
  const out = checkBrief(raw, { maxBytes: briefConfigOf(ctx).maxBytes });
  return out.ok ? null : out;
}

/** Prédicat de la liste d'exclusion hachée (`subject_exclusions`) ; `undefined` si la liste est vide (aucune clé lue). */
async function exclusionPredicate(ctx: ServerContext): Promise<((value: string) => boolean) | undefined> {
  const hashes = await loadSubjectExclusions(ctx.pool);
  if (hashes.size === 0 || ctx.keyChecked === null) return undefined;
  const key = await loadSubjectKey(ctx.pool, ctx.keyring, ctx.keyChecked);
  return (value: string) => isUsableSubjectValue(value) && hashes.has(subjectHash(key, value));
}

/** Prépare l'enregistrement (hors transaction : lecture de la liste d'exclusion et de la clé des sujets). */
export async function prepareBrief(ctx: ServerContext, brief: InvestigationBrief, now = new Date()) {
  const isExcluded = await exclusionPredicate(ctx);
  return normalizeBrief(brief, { receivedAt: now, ...(isExcluded === undefined ? {} : { isExcluded }) });
}

/** Enregistre la version du dossier dans la transaction de création de l'API (propriétaire). */
export async function saveBrief(
  tx: Queryable,
  ctx: ServerContext,
  args: { apiId: string; ownerId: string; authorId: string; via: 'mcp' | 'rest' | 'console'; normalized: Awaited<ReturnType<typeof prepareBrief>> },
): Promise<{ version: number; sha256: string; created: boolean }> {
  return storeBrief(tx, { ...args, keep: briefConfigOf(ctx).versionsKeep });
}

export type BriefView = {
  readonly brief_version: number;
  readonly brief_report: BriefReportEntry[];
  readonly narrative: string[];
  readonly summary: { hints: number; tried: number; open_questions: number };
};

/** Langue du propriétaire (`users.locale`), lue hors du rôle d'acteur comme la fiche de compte ; `en` à défaut. */
export async function ownerNarrativeLocale(ctx: ServerContext, userId: string): Promise<NarrativeLocale> {
  const row = (await ctx.pool.query<{ locale: string }>('SELECT locale FROM users WHERE id = $1', [userId])).rows[0];
  return row?.locale === 'fr' ? 'fr' : 'en';
}

/**
 * Rapport du dossier d'une API (propriétaire seulement : lecture filtrée par `owner_id`) : états posés par le code (faits
 * de `brief_hint_outcomes` si l'enquête les a écrits, sinon état initial du digest), gabarits reconstruits, récit fermé.
 */
export async function briefViewOf(db: Queryable, args: { apiId: string; ownerId: string; pageUrl: string; locale?: NarrativeLocale; sessionOrTunnel?: boolean; now?: Date }): Promise<BriefView | null> {
  const stored = await readLatestBrief(db, args);
  if (stored === null) return null;
  // Dépendance session ou tunnel de l'API : un indice qui ne sera jamais sondé en direct n'est pas affiché « à sonder ».
  const context = (
    await db.query<{ session_or_tunnel: boolean | null }>(`SELECT (a.requires_session OR a.requires->>'tunnel' = 'true') AS session_or_tunnel FROM apis a WHERE a.id = $1`, [args.apiId])
  ).rows[0];
  const locale: NarrativeLocale = args.locale ?? 'en';
  const sessionOrTunnel = args.sessionOrTunnel ?? context?.session_or_tunnel === true;
  const outcomes = await readHintOutcomes(db, args);
  const host = URL.canParse(args.pageUrl) ? new URL(args.pageUrl).hostname.toLowerCase() : '';
  const digest = buildBriefDigest(stored.content, { pageUrl: args.pageUrl, scope: siteScope(host), now: args.now ?? new Date(), sessionOrTunnel, outcomes, subjectExcluded: stored.subject_excluded });
  const finals: FinalHint[] = finalizeBriefHints(digest, null, { confirmed: new Map() }, null).map((h) => {
    const fact = outcomes.get(h.identity_key);
    if (fact === undefined || h.state === 'ignored') return h.state === 'unverified' ? { ...h, reason: null } : h;
    return { ...h, state: fact.state, reason: (fact.reason as FinalHint['reason']) ?? null };
  });
  const report = briefReport(finals);
  const summary = { hints: (stored.content.hints ?? []).length, tried: (stored.content.tried ?? []).length, open_questions: (stored.content.open_questions ?? []).length };
  return {
    brief_version: stored.version,
    brief_report: report,
    narrative: briefNarrative(report, { ...summary, breaker_open: false, brief_version: stored.version }, locale),
    summary,
  };
}

