// SPDX-License-Identifier: AGPL-3.0-only
import type { Clock } from './clock.ts';

type Lot = 'base' | 'q1' | 's5' | 'o8' | 'agent';

export interface FxRequest {
  method: string;
  /** Chemin sans chaîne de requête. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  /** Hôte virtuel : en-tête Host en minuscules, sans le port. */
  host: string;
}

export interface FxResponse {
  status: number;
  headers?: Record<string, string | string[]>;
  body?: string;
  /** Coupe la connexion sans réponse (erreur réseau simulée). */
  destroy?: boolean;
}

export interface Env {
  clock: Clock;
  seed: number;
  /** URL absolue d'un hôte virtuel de ce serveur (port compris). */
  urlFor(host: string, path: string): string;
}

export interface Site {
  id: string;
  lot: Lot;
  description: string;
  hosts: string[];
  /** Requête de fumée : après un reset, ce chemin répond avec ce statut. */
  smoke: { path: string; status: number };
  /** Le site sert lui-même /robots.txt ; sinon une réponse permissive par défaut. */
  ownsRobots?: boolean;
  handle(req: FxRequest): FxResponse | Promise<FxResponse>;
  control?(args: Record<string, unknown>): unknown;
}

export type SiteFactory = (env: Env) => Site;

export class ControlError extends Error {}
