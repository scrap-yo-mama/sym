// SPDX-License-Identifier: AGPL-3.0-only
// assert_openapi_client_in_sync (06 § 1, tâche 3.3) : le client généré committé (packages/client/src/generated/schema.ts)
// est exactement ce que produit openapi-typescript depuis l'OpenAPI spécifiée (packages/client/openapi/openapi.yaml).
// La tâche 3.6 le rejoue contre l'OpenAPI générée par le serveur (3.1). En attendant, un second contrôle compare l'OpenAPI
// spécifiée aux routes réellement enregistrées par `server` (registre INV12) : aucune route livrée ne manque au client.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ROUTES } from '../apps/server/src/routes/registry.ts';
import { generateSchema, GENERATED_URL, isInSync, SPEC_URL } from '../scripts/gen-openapi-client.ts';

/** « MÉTHODE /chemin/{param} » de chaque opération du fichier généré. */
function operationsOf(generated: string): string[] {
  const out: string[] = [];
  let path: string | null = null;
  for (const line of generated.split('\n')) {
    const pathMatch = /^ {4}"(\/[^"]+)": \{$/.exec(line);
    if (pathMatch) path = pathMatch[1] ?? null;
    const opMatch = /^ {8}(get|put|post|delete|patch): operations\[/.exec(line);
    if (path && opMatch) out.push(`${(opMatch[1] ?? '').toUpperCase()} ${path}`);
    if (line === 'export type webhooks = Record<string, never>;') path = null;
  }
  return out.sort();
}

describe('assert_openapi_client_in_sync', () => {
  test('le client committé est identique à la génération depuis l’OpenAPI spécifiée', async () => {
    expect(await isInSync()).toBe(true);
  });

  test('une OpenAPI modifiée sans régénération est détectée', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zz_test_openapi-'));
    try {
      const drifted = join(dir, 'openapi.yaml');
      writeFileSync(drifted, readFileSync(SPEC_URL, 'utf8').replace('operationId: getHealth', 'operationId: getHealthz'));
      expect(await isInSync(pathToFileURL(drifted), GENERATED_URL)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('la génération est déterministe', async () => {
    expect(await generateSchema()).toBe(await generateSchema());
  });
});

describe('OpenAPI spécifiée et routes livrées', () => {
  /** Spécifiées mais livrées plus tard (3.1 : flux d'événements persistés). */
  const SPECIFIED_NOT_YET_DELIVERED = ['GET /api/events'];

  test('chaque route enregistrée par le serveur figure dans l’OpenAPI spécifiée, et réciproquement', () => {
    const specified = operationsOf(readFileSync(GENERATED_URL, 'utf8'));
    const delivered = ROUTES.map((route) => `${route.method} ${route.url.replace(/:(\w+)/g, '{$1}')}`).sort();
    expect(specified.filter((op) => !SPECIFIED_NOT_YET_DELIVERED.includes(op))).toEqual(delivered);
  });
});
