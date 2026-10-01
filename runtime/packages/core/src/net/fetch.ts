// SPDX-License-Identifier: AGPL-3.0-only
// Niveau fetch de la garde SSRF (08b §1) : connecteur undici qui résout et contrôle à chaque connexion,
// socket épinglé sur l'adresse validée (ferme le rebinding), redirections suivies à la main et recontrôlées.
import { isIP } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch, Headers, type Dispatcher, type RequestInit, type Response } from 'undici';
import { DomainNotAllowedError, findDomainNotAllowed } from './domain-lock.js';
import { findSsrfBlocked, SsrfBlockedError, type SsrfGuard } from './guard.js';
import { stripAddress } from './ip.js';

/**
 * Connecteur undici gardé. Chaque nouvelle connexion : résolution unique, contrôle de toutes les adresses,
 * connexion sur l'adresse validée (`hostname` = IP, `servername` = nom pour SNI et vérification du certificat),
 * puis contrôle de défense en profondeur sur `socket.remoteAddress`.
 */
export function createGuardedConnector(
  guard: SsrfGuard,
  base: buildConnector.connector = buildConnector({}),
): buildConnector.connector {
  return (options, callback) => {
    const host = stripAddress(options.hostname);
    const port = options.port === '' ? (options.protocol === 'https:' ? 443 : 80) : Number(options.port);
    guard.resolve(host, port).then(
      (pinned) => {
        const servername = isIP(host) === 0 ? host : options.servername;
        base({ ...options, hostname: pinned.address, servername }, (...args) => {
          const [error, socket] = args;
          if (error !== null) {
            callback(error, null);
            return;
          }
          try {
            // Échec fermé : une adresse distante inconnue est refusée (classée `invalid`).
            guard.checkAddress(host, socket.remoteAddress ?? '', port);
          } catch (blocked) {
            socket.destroy();
            callback(blocked as Error, null);
            return;
          }
          callback(null, socket);
        });
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null),
    );
  };
}

/** Dispatcher undici dont toutes les connexions passent par la garde. */
export function createGuardedDispatcher(guard: SsrfGuard, connectTimeoutMs = 10_000): Agent {
  return new Agent({ connect: createGuardedConnector(guard, buildConnector({ timeout: connectTimeoutMs })) });
}

const SHARED = new WeakMap<SsrfGuard, Agent>();

/** Dispatcher gardé partagé par garde (un seul Agent et son pool, pas un Agent par appel). */
export function sharedGuardedDispatcher(guard: SsrfGuard): Agent {
  let agent = SHARED.get(guard);
  if (agent === undefined) {
    agent = createGuardedDispatcher(guard);
    SHARED.set(guard, agent);
  }
  return agent;
}

/** En-têtes conservés sur une redirection vers une autre origine ; tous les autres (secrets compris) tombent. */
const CROSS_ORIGIN_HEADERS: readonly string[] = ['accept', 'accept-language', 'user-agent', 'cache-control', 'pragma'];

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
export const MAX_REDIRECTS = 5;

export type GuardedFetchOptions = {
  guard: SsrfGuard;
  /** Dispatcher gardé (défaut : partagé par garde). Les modes proxy (`net/modes`) passent le leur. */
  dispatcher?: Dispatcher;
  maxRedirects?: number;
  /** false : aucune redirection suivie, la réponse 3xx est rendue telle quelle (webhooks). */
  followRedirects?: boolean;
  /**
   * Verrou de domaines (tâche 1.6) : contrôlé à CHAQUE saut, avant toute connexion. Un hôte refusé lève
   * `DomainNotAllowedError` ; aucun octet ne part vers lui (une redirection ouverte du site ne sort pas de l'API).
   */
  allowHost?: (host: string) => boolean;
  /** Appelé avant chaque envoi (chaque saut compte) : contrôle du plafond de coût du run, qui lève pour refuser. */
  beforeRequest?: () => void;
};

type Init = Omit<RequestInit, 'dispatcher' | 'redirect'>;

/**
 * fetch sous garde : `redirect: 'manual'`, 5 sauts au plus, chaque saut repasse par la garde, `https` vers
 * `http` refusé, schémas http(s) seulement. Une connexion refusée lève `SsrfBlockedError` (code `ssrf_blocked`) :
 * aucun corps de réponse interne ne remonte.
 */
export async function guardedFetch(input: string | URL, init: Init, options: GuardedFetchOptions): Promise<Response> {
  const { guard } = options;
  const dispatcher = options.dispatcher ?? sharedGuardedDispatcher(guard);
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  let url = new URL(input);
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers);
  for (let hop = 0; ; hop++) {
    guard.checkUrlStatic(url);
    if (options.allowHost !== undefined && !options.allowHost(url.hostname)) throw new DomainNotAllowedError(url.hostname);
    options.beforeRequest?.();
    let response: Response;
    try {
      response = await undiciFetch(url, { ...init, method, body, headers, redirect: 'manual', dispatcher });
    } catch (error) {
      throw findSsrfBlocked(error) ?? findDomainNotAllowed(error) ?? error;
    }
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || location === null || options.followRedirects === false) return response;
    await response.body?.cancel();
    const next = new URL(location, url);
    const host = next.hostname;
    if (hop >= maxRedirects) throw new SsrfBlockedError({ reason: 'too_many_redirects', host });
    if (url.protocol === 'https:' && next.protocol === 'http:') {
      throw new SsrfBlockedError({ reason: 'https_downgrade', host });
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    if (next.origin !== url.origin) {
      // Autre origine : liste blanche d'en-têtes, et le corps n'est jamais renvoyé.
      const kept = new Headers();
      for (const name of CROSS_ORIGIN_HEADERS) {
        const value = headers.get(name);
        if (value !== null) kept.set(name, value);
      }
      headers = kept;
      if (body !== undefined && body !== null) {
        body = undefined;
        if (method !== 'GET' && method !== 'HEAD') method = 'GET';
      }
    }
    url = next;
  }
}

/**
 * Politique `operator-config` (08b § 1) au niveau fetch : destination réglée par l'admin lui-même (fournisseur OIDC de
 * l'instance), jamais par un membre, un LLM ou une API. Adresses privées et boucle locale permises (un IdP interne,
 * Keycloak sur le réseau de l'entreprise), classes dures toujours refusées (métadonnées cloud, 0.0.0.0, multicast,
 * diffusion). Résolution unique, socket épinglé, `remoteAddress` recontrôlée. Aucune redirection suivie.
 */
export function createOperatorConfigDispatcher(guard: SsrfGuard, opts: { connectTimeoutMs?: number; ca?: string[] } = {}): Agent {
  const base = buildConnector({ timeout: opts.connectTimeoutMs ?? 10_000, ...(opts.ca ? { ca: opts.ca } : {}) });
  const connect: buildConnector.connector = (options, callback) => {
    const host = stripAddress(options.hostname);
    const port = options.port === '' ? (options.protocol === 'https:' ? 443 : 80) : Number(options.port);
    guard.resolveOperatorConfig(host, port).then(
      (pinned) => {
        const servername = isIP(host) === 0 ? host : options.servername;
        base({ ...options, hostname: pinned.address, servername }, (...args) => {
          const [error, socket] = args;
          if (error !== null) {
            callback(error, null);
            return;
          }
          try {
            guard.checkOperatorAddress(host, socket.remoteAddress ?? '', port);
          } catch (blocked) {
            socket.destroy();
            callback(blocked as Error, null);
            return;
          }
          callback(null, socket);
        });
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), null),
    );
  };
  return new Agent({ connect });
}

/** fetch `operator-config` : http(s) seulement, sans identifiants dans l'URL, aucune redirection suivie. */
export async function operatorConfigFetch(input: string | URL, init: Init, dispatcher: Dispatcher): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfBlockedError({ reason: 'scheme', host: url.hostname });
  if (url.username !== '' || url.password !== '') throw new SsrfBlockedError({ reason: 'credentials', host: url.hostname });
  try {
    return await undiciFetch(url, { ...init, redirect: 'manual', dispatcher });
  } catch (error) {
    throw findSsrfBlocked(error) ?? error;
  }
}

/**
 * fetch d'un fournisseur OIDC (08b § 1). Seule l'origine de l'issuer, saisie par l'owner, relève de `operator-config`
 * (IdP interne : privé et boucle locale permis). Les autres points d'entrée viennent du document de découverte, donc de
 * l'IdP (`token_endpoint`, `jwks_uri`, `userinfo_endpoint`) : hors de cette origine, ils suivent la politique des cibles
 * (`untrusted-target` : ports 80 et 443, privé seulement par `ALLOWED_PRIVATE_HOSTS`). Un IdP malveillant ou compromis
 * ne fait donc pas poster le code, le vérificateur PKCE ni le secret du client vers un service interne. Aucune
 * redirection suivie, dans un cas comme dans l'autre.
 */
export function createIssuerScopedFetch(
  issuer: string | URL,
  guard: SsrfGuard,
  operatorDispatcher: Dispatcher,
  targetDispatcher: Dispatcher = sharedGuardedDispatcher(guard),
): (input: string | URL, init: Init) => Promise<Response> {
  const origin = new URL(issuer).origin;
  return (input, init) =>
    new URL(input).origin === origin
      ? operatorConfigFetch(input, init, operatorDispatcher)
      : guardedFetch(input, init, { guard, dispatcher: targetDispatcher, followRedirects: false });
}
