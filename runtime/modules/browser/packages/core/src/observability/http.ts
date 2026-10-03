// SPDX-License-Identifier: AGPL-3.0-only
// `GET /metrics` (cdc/sym-browser 04d § 3.1, tâche 3.7) : accès par `Authorization: Bearer <SYMB_METRICS_TOKEN>`,
// comparaison à temps constant ; sans jeton configuré, la route reste fermée (401), jamais ouverte par défaut. Réponse
// indépendante du serveur (hôte de service `node:http` ou Fastify de la passerelle).
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Secret } from '../crypto/redact.js';
import type { MetricsRegistry } from './registry.js';

export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export type MetricsResponse = { status: 200 | 401; headers: Record<string, string>; body: string };

/** Vrai si l'en-tête porte exactement le jeton attendu. Empreintes SHA-256 comparées : longueur sans effet sur le temps. */
export function metricsAuthorized(token: Pick<Secret, 'reveal'> | null, authorization: string | undefined): boolean {
  if (token === null || typeof authorization !== 'string') return false;
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return false;
  const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(digest(match[1]!), digest(token.reveal()));
}

export async function metricsResponse(registry: MetricsRegistry, token: Pick<Secret, 'reveal'> | null, authorization: string | undefined): Promise<MetricsResponse> {
  const headers = { 'cache-control': 'no-store' };
  if (!metricsAuthorized(token, authorization)) {
    return { status: 401, headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'www-authenticate': 'Bearer' }, body: '{"error":"unauthorized"}' };
  }
  return { status: 200, headers: { ...headers, 'content-type': METRICS_CONTENT_TYPE }, body: await registry.render() };
}
