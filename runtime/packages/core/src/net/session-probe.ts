// SPDX-License-Identifier: AGPL-3.0-only
// Test de validité d'une session de site (CDC V1 sym-sessions, B1, F4) : une requête légère, GET seul, vers une page du
// domaine de la session (son origine par défaut). Ce module ne fait aucune I/O : l'appelant (le worker) fournit l'envoi
// sous garde (SSRF, cadence, Cookie limité au domaine) ; ici seule la lecture de la réponse est décidée.
//
// Heuristique bornée (documentée dans la note de `assert_session_live_status`) :
//   morte         401 ou 403 (hors page de défi), ou redirection vers une page de connexion usuelle (`isLoginPath`) ;
//   vivante       2xx, après au plus PROBE_MAX_HOPS redirections qui restent dans le domaine de la session ;
//   non concluante tout le reste : 404, 429, 5xx, défi de protection (jamais contourné, INV6), redirection hors domaine,
//                 boucle de redirections, panne réseau.
// Limite assumée : un site dont l'origine est publique répond 2xx sans cookie ; le test le dit « vivante » alors que la
// session peut être expirée. La preuve forte reste le rejeu d'un run (401/403 → « à renouveler »).
// Les codes rendus sont courts et ne contiennent jamais de valeur du site ni de cookie (`site_session_events.outcome`).
import { isLoginPath } from '../exec/classify.js';
import { hostWithinSessionDomain } from './session-cookies.js';

export const PROBE_MAX_HOPS = 3;

/** Page sondée par défaut : l'origine du domaine de la session. */
export function sessionProbeUrl(domain: string): URL {
  return new URL(`https://${domain}/`);
}

/** Ce que l'envoi sous garde rend de la réponse : rien de son corps. */
export type ProbeResponse = {
  readonly status: number;
  readonly location: string | null;
  /** La réponse est une page ou un en-tête de défi de protection (jamais lu comme une session morte). */
  readonly protection: boolean;
};

export type ProbeStep = { readonly done: true; readonly outcome: string } | { readonly done: false; readonly next: URL };

/** Lecture d'UNE réponse : verdict final, ou prochaine URL à sonder (redirection dans le domaine de la session). */
export function judgeProbeResponse(response: ProbeResponse, current: URL, sessionDomain: string): ProbeStep {
  const { status } = response;
  if (response.protection) return { done: true, outcome: 'inconclusive_protection' };
  if (status === 401) return { done: true, outcome: 'dead_http_401' };
  if (status === 403) return { done: true, outcome: 'dead_http_403' };
  if (status >= 200 && status < 300) return { done: true, outcome: 'alive' };
  if (status >= 300 && status < 400) {
    if (response.location === null || response.location === '') return { done: true, outcome: `inconclusive_http_${status}` };
    let next: URL;
    try {
      next = new URL(response.location, current);
    } catch {
      return { done: true, outcome: 'inconclusive_redirect' };
    }
    if (isLoginPath(next.pathname) && !isLoginPath(current.pathname)) return { done: true, outcome: 'dead_login_redirect' };
    if ((next.protocol !== 'https:' && next.protocol !== 'http:') || !hostWithinSessionDomain(next.hostname, sessionDomain)) {
      return { done: true, outcome: 'inconclusive_redirect_offsite' };
    }
    return { done: false, next };
  }
  if (status === 429) return { done: true, outcome: 'inconclusive_rate_limited' };
  if (status >= 500) return { done: true, outcome: 'inconclusive_http_5xx' };
  return { done: true, outcome: `inconclusive_http_${status}` };
}

/**
 * Sonde une session : GET de `start` (l'origine du domaine par défaut), puis chaque redirection dans le domaine.
 * `send` envoie UN GET sans suivre de redirection ; il renvoie la réponse lue, ou `null` quand l'envoi n'a pas eu lieu
 * (cadence refusée) ; une exception levée par `send` (SSRF, réseau) est un résultat non concluant, jamais une erreur.
 */
export async function probeSession(options: { domain: string; start?: URL; send: (url: URL) => Promise<ProbeResponse | null> }): Promise<string> {
  let url = options.start ?? sessionProbeUrl(options.domain);
  for (let hop = 0; hop <= PROBE_MAX_HOPS; hop++) {
    let response: ProbeResponse | null;
    try {
      response = await options.send(url);
    } catch {
      return 'inconclusive_network';
    }
    if (response === null) return 'inconclusive_paced';
    const step = judgeProbeResponse(response, url, options.domain);
    if (step.done) return step.outcome;
    url = step.next;
  }
  return 'inconclusive_redirect_loop';
}
