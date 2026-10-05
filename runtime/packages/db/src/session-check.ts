// SPDX-License-Identifier: AGPL-3.0-only
// État et journal d'usage des sessions de site (CDC V1 sym-sessions, B1 ; INV5, INV8, INV12). Complète `extension.ts` :
// - test de validité à la demande du propriétaire (file pg-boss `site-session-check`, exécutée par le worker : le serveur
//   web n'envoie jamais de requête vers un site), résultat écrit en `last_checked_at` et en événement `checked` ;
// - demande de rafraîchissement (`refresh_requested`) quand une session consentie ne sert plus, et signal pour l'extension ;
// - étiquette de compte.
// Identités : les écritures `checked` et `refresh_requested` sont du SYSTÈME (le rôle des requêtes ne peut insérer que
// `revoked` et `refreshed`, 0027) ; les lectures et l'étiquette passent par `withActor` (RLS propriétaire).
// Aucun secret ne traverse ces fonctions : les codes de résultat sont courts et sans valeur du site.
import type { JobQueue, Kek, QueueDefinition } from '@runtime/core';
import type pg from 'pg';
import { openSiteCookies, type RunSiteSession } from './extension.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

/** File du test de validité : un job par session, regroupé tant qu'il attend (politique `short`). */
export const SITE_SESSION_CHECK_QUEUE = 'site-session-check';
export type SiteSessionCheckJob = { readonly owner_id: string; readonly site_session_id: string; readonly domain: string };

export function siteSessionCheckQueueDefinition(): QueueDefinition {
  return { name: SITE_SESSION_CHECK_QUEUE, expireInSeconds: 120, heartbeatSeconds: 30, retryLimit: 1, policy: 'short', deleteAfterSeconds: 24 * 3600 };
}

/** Met un test en file ; `null` : un test de cette session attend déjà. Le propriétaire est déjà vérifié par l'appelant. */
export async function enqueueSiteSessionCheck(queue: JobQueue, job: SiteSessionCheckJob): Promise<string | null> {
  return queue.enqueueOnce<SiteSessionCheckJob>(SITE_SESSION_CHECK_QUEUE, { ...job }, { singletonKey: `check:${job.site_session_id}` });
}

/**
 * Session à tester (identité système, worker) : relue par (propriétaire, identifiant) puis ouverte sous la KEK ; jamais
 * la session d'un autre. `null` : la session n'existe plus ou n'appartient pas à ce propriétaire (rien n'est écrit).
 */
export async function siteCookiesForCheck(db: Queryable, kek: Kek, input: { ownerId: string; siteSessionId: string }): Promise<{ domain: string; session: RunSiteSession } | null> {
  const row = (await db.query<{ domain: string }>('SELECT domain FROM site_sessions WHERE id = $1 AND owner_id = $2', [input.siteSessionId, input.ownerId])).rows[0];
  if (!row) return null;
  return { domain: row.domain, session: await openSiteCookies(db, kek, { ownerId: input.ownerId, domain: row.domain }) };
}

/**
 * Résultat d'un test de validité (identité système) : `last_checked_at` et un événement `checked`, `outcome` = code court
 * (`alive`, `dead_http_401`, `inconclusive_network`...). Renvoie faux si la session a disparu entre-temps.
 */
export async function recordSessionCheck(db: Queryable, input: { ownerId: string; siteSessionId: string; domain: string; outcome: string }): Promise<boolean> {
  const { rowCount } = await db.query('UPDATE site_sessions SET last_checked_at = now() WHERE id = $1 AND owner_id = $2 AND domain = $3', [
    input.siteSessionId,
    input.ownerId,
    input.domain,
  ]);
  if (rowCount !== 1) return false;
  await db.query(`INSERT INTO site_session_events (owner_id, site_session_id, domain, event, outcome) VALUES ($1, $2, $3, 'checked', $4)`, [
    input.ownerId,
    input.siteSessionId,
    input.domain,
    input.outcome.slice(0, 120),
  ]);
  return true;
}

/**
 * Session consentie du propriétaire d'un run, pour ce domaine : la ligne existe ET l'usage serveur est autorisé. C'est la
 * condition pour que le refus d'une session (absente, expirée, illisible) soit « à rafraîchir » et non un repli sur le
 * tunnel. Même garde de propriétaire que `siteCookiesForRun` : le run, l'API et sa copie recopiée ont le même propriétaire.
 * `null` : pas de consentement, ou run d'un autre compte que le propriétaire de l'API (rien n'est jamais écrit pour autrui).
 */
export async function consentedSessionForRun(db: Queryable, input: { runId: string; domain: string }): Promise<{ id: string; ownerId: string } | null> {
  const { rows } = await db.query<{ id: string; owner_id: string }>(
    `SELECT s.id, s.owner_id
     FROM runs r
     JOIN apis a ON a.id = r.api_id AND a.owner_id = r.owner_id AND a.owner_id = r.api_owner_id
     JOIN site_sessions s ON s.owner_id = r.owner_id AND s.domain = $2 AND s.server_use_allowed
     WHERE r.id = $1`,
    [input.runId, input.domain],
  );
  return rows[0] ? { id: rows[0].id, ownerId: rows[0].owner_id } : null;
}

/**
 * Demande de rafraîchissement (identité système, worker) : événement `refresh_requested` rattaché au run qui a constaté
 * que la session ne sert plus. Rien n'est écrit sans session consentie du propriétaire du run. Renvoie vrai si écrit.
 */
export async function requestSessionRefresh(db: Queryable, input: { runId: string; domain: string; outcome: string }): Promise<boolean> {
  const site = await consentedSessionForRun(db, input);
  if (!site) return false;
  await db.query(`INSERT INTO site_session_events (owner_id, site_session_id, domain, event, run_id, outcome) VALUES ($1, $2, $3, 'refresh_requested', $4, $5)`, [
    site.ownerId,
    site.id,
    input.domain,
    input.runId,
    input.outcome.slice(0, 120),
  ]);
  return true;
}

export type RefreshRequest = { domain: string; requestedAt: Date };

/**
 * Domaines à rafraîchir pour l'utilisateur (transaction `withActor`) : un `refresh_requested` sans `refreshed` derrière,
 * sur une session consentie encore présente. Consommé par l'extension (B2) ; ne dit rien d'autre que le domaine.
 */
export async function listRefreshRequests(db: Queryable, ownerId: string): Promise<RefreshRequest[]> {
  const { rows } = await db.query<{ domain: string; requested_at: Date }>(
    `SELECT s.domain, max(e.created_at) AS requested_at
     FROM site_sessions s
     JOIN site_session_events e ON e.owner_id = s.owner_id AND e.domain = s.domain AND e.event = 'refresh_requested'
     WHERE s.owner_id = $1 AND s.server_use_allowed
     GROUP BY s.owner_id, s.domain
     HAVING max(e.created_at) > coalesce((SELECT max(f.created_at) FROM site_session_events f WHERE f.owner_id = s.owner_id AND f.domain = s.domain AND f.event = 'refreshed'), '-infinity'::timestamptz)
     ORDER BY s.domain`,
    [ownerId],
  );
  return rows.map((r) => ({ domain: r.domain, requestedAt: r.requested_at }));
}

/** Longueur maximale d'une étiquette (la contrainte `site_sessions_account_label_len` de 0027 tient la même borne). */
export const ACCOUNT_LABEL_MAX = 120;

/**
 * Étiquette de compte (transaction `withActor`) : texte libre borné, sans caractère de contrôle ; vide → effacée.
 * Renvoie `not_found` pour une session absente ou d'un autre (RLS + propriétaire), `invalid` pour une étiquette refusée.
 */
export async function setAccountLabel(db: Queryable, ownerId: string, id: string, label: string | null): Promise<'updated' | 'not_found' | 'invalid'> {
  const clean = label === null ? null : label.trim();
  // eslint-disable-next-line no-control-regex
  if (clean !== null && (clean.length > ACCOUNT_LABEL_MAX || /[\u0000-\u001f\u007f]/.test(clean))) return 'invalid';
  const { rowCount } = await db.query('UPDATE site_sessions SET account_label = $3, updated_at = now() WHERE id = $1 AND owner_id = $2', [id, ownerId, clean === '' ? null : clean]);
  return rowCount === 1 ? 'updated' : 'not_found';
}
