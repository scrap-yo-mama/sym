// SPDX-License-Identifier: AGPL-3.0-only
// `GET /api/openapi.json` (tâche 3.1, 05 § 2) : l'OpenAPI 3.1 que sert le serveur. Elle part de l'OpenAPI spécifiée
// (packages/client/openapi/openapi.yaml, générée dans `generated/openapi.ts`) et n'en garde que les opérations
// ENREGISTRÉES par ce serveur (registre INV12) : une route en préparation n'y figure pas, et aucune marque `x-pending`
// n'en sort. La tâche 3.6 compare ce document à l'OpenAPI spécifiée (15 § 6).
import type { FastifyInstance } from 'fastify';
import { SPECIFIED_OPENAPI_JSON } from '../generated/openapi.js';

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

type Operation = Record<string, unknown>;
type PathItem = Partial<Record<(typeof METHODS)[number], Operation>> & Record<string, unknown>;

/** Document livré : opérations dont `MÉTHODE /chemin/:param` est dans `registered`. */
export function deliveredOpenApi(registered: readonly string[]): Record<string, unknown> {
  const spec = JSON.parse(SPECIFIED_OPENAPI_JSON) as { paths: Record<string, PathItem> } & Record<string, unknown>;
  const routes = new Set(registered);
  const paths: Record<string, PathItem> = {};
  for (const [path, item] of Object.entries(spec.paths)) {
    const kept: PathItem = {};
    for (const [key, value] of Object.entries(item)) {
      if (!(METHODS as readonly string[]).includes(key)) {
        kept[key] = value;
        continue;
      }
      const route = `${key.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`;
      if (!routes.has(route)) continue;
      const { ['x-pending']: _pending, ...operation } = value as Operation;
      kept[key] = operation;
    }
    if (METHODS.some((m) => m in kept)) paths[path] = kept;
  }
  return { ...spec, paths };
}

export function openapiRoutes(app: FastifyInstance): void {
  let cached: Record<string, unknown> | undefined;
  app.get('/api/openapi.json', async () => (cached ??= deliveredOpenApi(app.registeredRoutes)));
}
