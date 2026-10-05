// SPDX-License-Identifier: AGPL-3.0-only
// Test de validité d'une session de site (CDC V1 sym-sessions, B1, F4) : exécuté par le worker, jamais par le serveur web
// (INV10 : seul le worker envoie des requêtes vers les sites). Même chemin gardé que le rejeu serveur (A2) :
// - SSRF : `openNetworkSession` (garde des cibles, résolution revérifiée à chaque saut), barreau direct ;
// - cadence : la clé de domaine du pacer partagé avec les runs, avec son disjoncteur ;
// - Cookie : `createSessionCookies`, recalculé par saut, jamais hors du domaine de la session ; valeurs au registre de masquage ;
// - GET seul, sans corps, sans suivre les redirections hors domaine ; aucun en-tête `Authorization`.
// Résultat : `last_checked_at` et un événement `checked` dont `outcome` est un code court (voir `probeSession`), jamais une
// valeur du site ni un cookie.
import { detectChallengePage, domainRequestPacer, protectionSignal, type RequestPacer } from '@runtime/core/exec';
import type { DomainPacer, Kek } from '@runtime/core';
import { createSessionCookies, openNetworkSession, probeSession, sessionProbeUrl, type Resolver, type SsrfGuard } from '@runtime/core/net';
import { recordSessionCheck, siteCookiesForCheck, type SiteSessionCheckJob } from '@runtime/db';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { RobotIdentity } from './robot-identity.js';

/** Attente maximale d'un créneau de cadence : au-delà, le test est non concluant (`inconclusive_paced`), pas bloquant. */
const CHECK_MAX_WAIT_MS = 15_000;
/** Corps lu pour reconnaître une page de défi sur un 401/403 : un interstitiel est petit. */
const CHALLENGE_SCAN_BYTES = 64 * 1024;

export type SessionCheckDeps = {
  readonly pool: pg.Pool;
  readonly kek: Kek;
  readonly guard: SsrfGuard;
  readonly pacer?: DomainPacer;
  /** Identité du robot (User-Agent, `From`) : la même que celle des runs. Une erreur d'identité rend le test non concluant. */
  readonly identity?: () => Promise<RobotIdentity>;
  readonly proxyResolver?: Resolver;
  /** Première page sondée (tests : serveur local en http). Défaut : l'origine https du domaine de la session. */
  readonly startUrl?: (domain: string) => URL;
  readonly logger?: Logger;
};

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < CHALLENGE_SCAN_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  return Buffer.concat(chunks).toString('utf8', 0, CHALLENGE_SCAN_BYTES);
}

const headersOf = (response: Response): Record<string, string> => {
  const out: Record<string, string> = {};
  response.headers.forEach((value, key) => (out[key] = value));
  return out;
};

/** Traite un job `site-session-check` ; rend le code de résultat écrit, ou `null` si rien n'a été écrit (session disparue, mode tunnel). */
export function createSessionCheck(deps: SessionCheckDeps): (job: SiteSessionCheckJob) => Promise<string | null> {
  const pacer: RequestPacer | undefined = deps.pacer === undefined ? undefined : domainRequestPacer(deps.pacer, { maxWaitMs: CHECK_MAX_WAIT_MS });
  const finish = async (job: SiteSessionCheckJob, outcome: string): Promise<string | null> => {
    const written = await recordSessionCheck(deps.pool, { ownerId: job.owner_id, siteSessionId: job.site_session_id, domain: job.domain, outcome });
    return written ? outcome : null;
  };
  return async (job) => {
    const found = await siteCookiesForCheck(deps.pool, deps.kek, { ownerId: job.owner_id, siteSessionId: job.site_session_id });
    // Session disparue (déconnexion) ou domaine changé : rien à tester, rien à écrire.
    if (found === null || found.domain !== job.domain) return null;
    if (!found.session.ok) {
      if (found.session.reason === 'tunnel_only') return null;
      // Aucun cookie vivant à envoyer : la session est morte sans qu'une requête soit nécessaire.
      return finish(job, found.session.reason === 'cookie_expired' ? 'dead_expired' : 'dead_no_session');
    }
    const cookies = createSessionCookies(found.domain, found.session.cookies);
    let identity: RobotIdentity | undefined;
    if (deps.identity !== undefined) {
      try {
        identity = await deps.identity();
      } catch {
        return finish(job, 'inconclusive_identity');
      }
    }
    const network = openNetworkSession({
      rung: { mode: 'direct' },
      guard: deps.guard,
      ...(deps.proxyResolver === undefined ? {} : { proxyResolver: deps.proxyResolver }),
      allowedHosts: [found.domain],
      allowedHostSuffixes: [found.domain],
      sessionCookies: cookies,
      ...(identity === undefined ? {} : { userAgent: identity.userAgent, ...(identity.from === null ? {} : { from: identity.from }) }),
    });
    try {
      const outcome = await probeSession({
        domain: found.domain,
        start: (deps.startUrl ?? sessionProbeUrl)(found.domain),
        send: async (url) => {
          if (pacer !== undefined && !(await pacer.acquire(url.href)).granted) return null;
          const response = await network.fetch(url, { method: 'GET', headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.5' } }, { followRedirects: false });
          const headers = headersOf(response);
          const body = response.status === 401 || response.status === 403 ? await readCapped(response) : (await response.body?.cancel().catch(() => undefined), '');
          await pacer?.report(url.href, { status: response.status, retryAfter: response.headers.get('retry-after') }).catch(() => undefined);
          return {
            status: response.status,
            location: response.headers.get('location'),
            // Un défi de protection n'est pas une session morte : jamais contourné ni confondu (INV6).
            protection: protectionSignal(headers) !== null || detectChallengePage(body, headers) !== null,
          };
        },
      });
      deps.logger?.info({ domain: found.domain, outcome }, 'session : test de validité');
      return await finish(job, outcome);
    } finally {
      await network.close().catch(() => undefined);
    }
  };
}
