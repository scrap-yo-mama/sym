// SPDX-License-Identifier: MIT
// Client généré depuis l'OpenAPI (tâche 3.4, 04 § 10 « types générés depuis l'OpenAPI ») : le fichier committé
// `src/generated/openapi.ts` est exactement ce que produit `pnpm --filter @sym-browser/sdk gen` depuis `browserOpenApi`
// de `@sym/contracts/browser` ; chaque opération de l'OpenAPI a son entrée dans la table des opérations ; une OpenAPI
// modifiée sans régénération est détectée.
import { readFileSync } from 'node:fs';
import { browserOpenApi } from '@sym/contracts/browser';
import { describe, expect, test } from 'vitest';
import { GENERATED_URL, renderClient } from '../scripts/generate-client.ts';
import { OPERATIONS } from './generated/openapi.js';

describe('client généré depuis l’OpenAPI du contrat', () => {
  test('le fichier committé est identique à la génération courante', async () => {
    expect(readFileSync(GENERATED_URL, 'utf8')).toBe(await renderClient(browserOpenApi));
  });

  test('chaque opération de l’OpenAPI (operationId, méthode, chemin) est dans la table générée', () => {
    const expected: Record<string, { method: string; path: string }> = {};
    for (const [path, item] of Object.entries(browserOpenApi.paths)) {
      for (const [method, operation] of Object.entries(item as Record<string, { operationId: string }>)) {
        expected[operation.operationId] = { method: method.toUpperCase(), path: `/v1${path}` };
      }
    }
    expect(Object.keys(expected).length).toBeGreaterThanOrEqual(7);
    expect(Object.fromEntries(Object.entries(OPERATIONS).map(([id, op]) => [id, { method: op.method, path: op.path }]))).toEqual(expected);
  });

  test('une OpenAPI modifiée (nouvelle opération) change la génération', async () => {
    const drifted = structuredClone(browserOpenApi) as unknown as { paths: Record<string, unknown> };
    drifted.paths['/zz-drift'] = { get: { operationId: 'zzDrift', responses: { '200': { description: 'ok' } } } };
    expect(await renderClient(drifted as never)).not.toBe(await renderClient(browserOpenApi));
  });
});
