// SPDX-License-Identifier: AGPL-3.0-only
// assert_openapi_client_in_sync (06 § 1, tâche 3.3) : le client généré committé (packages/client/src/generated/schema.ts)
// est exactement ce que produit openapi-typescript depuis l'OpenAPI spécifiée (packages/client/openapi/openapi.yaml).
// La tâche 3.6 le rejoue contre l'OpenAPI générée par le serveur (3.1). En attendant, un second contrôle vérifie que
// l'OpenAPI spécifiée couvre 05 § 4.2 et 13 § 13.1, et que toute route livrée y figure (liste d'attente `x-pending`).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'vitest';
import { ROUTES } from '../apps/server/src/routes/registry.ts';
import { STOP_ON_NOT_FOUND_DEFAULT } from '../apps/web/src/lib/sse.ts';
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

/**
 * Opérations de l'OpenAPI spécifiée lues dans le YAML (`MÉTHODE /chemin`), avec la tâche qui doit les livrer
 * (`x-pending: '3.1'`) ou null si la route est déjà livrée. Lecture ligne à ligne : le fichier suit une indentation
 * fixe (chemins à 2 espaces, méthodes à 4, champs d'opération à 6), recoupée avec la génération ci-dessous.
 */
function specifiedOperations(yaml: string): Map<string, string | null> {
  const out = new Map<string, string | null>();
  let path: string | null = null;
  let current: string | null = null;
  let inPaths = false;
  for (const line of yaml.split('\n')) {
    if (/^\S/.test(line)) {
      inPaths = line === 'paths:';
      path = null;
      current = null;
      continue;
    }
    if (!inPaths) continue;
    const pathMatch = /^ {2}(\/\S*):$/.exec(line);
    if (pathMatch) {
      path = pathMatch[1] ?? null;
      current = null;
      continue;
    }
    const methodMatch = /^ {4}(get|put|post|delete|patch):$/.exec(line);
    if (path && methodMatch) {
      current = `${(methodMatch[1] ?? '').toUpperCase()} ${path}`;
      out.set(current, null);
      continue;
    }
    const pendingMatch = /^ {6}x-pending: '(\d+\.\d+[a-z]?)'$/.exec(line);
    if (current && pendingMatch) out.set(current, pendingMatch[1] ?? null);
  }
  return out;
}

/**
 * Routes REST du CDC, recopiées de 05 § 4.2 et 13 § 13.1 (`CRUD` développé en opérations). L'OpenAPI spécifiée doit
 * toutes les décrire : la console (3.4, 3.5, 3.8) s'appuie sur ces types sans attendre la livraison du serveur (3.1).
 */
const CDC_REST_ROUTES = [
  // 05 § 4.2
  'POST /api/apis',
  'POST /api/apis/{id}/validate-schema',
  'GET /api/apis',
  'GET /api/apis/{slug}',
  'PATCH /api/apis/{slug}',
  'DELETE /api/apis/{slug}',
  'POST /api/apis/{slug}/runs',
  'POST /api/apis/{slug}/investigate',
  'GET /api/apis/{slug}/export',
  'POST /api/apis/import',
  'GET /api/apis/{slug}/openapi.json',
  'GET /api/runs/{id}',
  'POST /api/runs/{id}/cancel',
  'POST /api/runs/{id}/resume',
  'GET /api/events',
  'GET /api/runs/{id}/events',
  'GET /api/datasets/{id}/items',
  'GET /api/apis/{slug}/schedules',
  'POST /api/apis/{slug}/schedules',
  'GET /api/apis/{slug}/schedules/{id}',
  'PATCH /api/apis/{slug}/schedules/{id}',
  'DELETE /api/apis/{slug}/schedules/{id}',
  'GET /api/webhook-subscriptions',
  'POST /api/webhook-subscriptions',
  'GET /api/webhook-subscriptions/{id}',
  'PATCH /api/webhook-subscriptions/{id}',
  'DELETE /api/webhook-subscriptions/{id}',
  'GET /api/settings/llm',
  'PUT /api/settings/llm',
  'GET /api/settings/proxies',
  'POST /api/settings/proxies',
  'GET /api/settings/proxies/{id}',
  'PATCH /api/settings/proxies/{id}',
  'DELETE /api/settings/proxies/{id}',
  'GET /api/settings/smtp',
  'PUT /api/settings/smtp',
  'GET /api/users',
  'PATCH /api/users/{id}',
  'DELETE /api/users/{id}',
  'GET /api/invitations',
  'POST /api/invitations',
  'DELETE /api/invitations/{id}',
  'GET /api/api-keys',
  'POST /api/api-keys',
  'DELETE /api/api-keys/{id}',
  'GET /api/audit',
  'GET /api/sso',
  'POST /api/subjects/erase',
  'POST /api/subjects/export',
  'POST /api/tunnel/pairing-code',
  'GET /api/health',
  'GET /api/ready',
  'GET /api/version',
  'GET /metrics',
  // 13 § 13.1
  'POST /api/setup',
  'POST /api/users/{id}/reset-link',
  'POST /api/owner/transfer',
  'POST /api/invitations/{id}/resend',
  'POST /api/invitations/accept',
  'GET /api/me/sessions',
  'DELETE /api/me/sessions',
  'DELETE /api/me/sessions/{id}',
  'POST /api/me/2fa/enroll',
  'POST /api/me/2fa/confirm',
  'POST /api/me/2fa/backup-codes',
  'DELETE /api/me/2fa',
  'GET /api/me/audit',
  'GET /api/audit/export',
  'GET /api/settings/security',
  'PUT /api/settings/security',
  'GET /api/settings/sso',
  'PUT /api/settings/sso',
  'GET /.well-known/oauth-protected-resource',
] as const;

describe('OpenAPI spécifiée et routes livrées', () => {
  const yaml = readFileSync(SPEC_URL, 'utf8');
  const specified = specifiedOperations(yaml);
  const delivered = ROUTES.map((route) => `${route.method} ${route.url.replace(/:(\w+)/g, '{$1}')}`).sort();

  test('la lecture du YAML trouve exactement les opérations du client généré', () => {
    expect([...specified.keys()].sort()).toEqual(operationsOf(readFileSync(GENERATED_URL, 'utf8')));
  });

  test('assert_openapi_specified_covers_cdc : chaque route REST de 05 § 4.2 et 13 § 13.1 est spécifiée', () => {
    expect(CDC_REST_ROUTES.filter((op) => !specified.has(op))).toEqual([]);
  });

  test('assert_openapi_specified_vs_delivered_drift : toute route livrée est spécifiée ; le reste est en liste d’attente', () => {
    // Inclusion : une route enregistrée par le serveur (registre INV12) figure dans l'OpenAPI spécifiée, sans `x-pending`.
    expect(delivered.filter((op) => !specified.has(op))).toEqual([]);
    expect(delivered.filter((op) => specified.get(op) !== null)).toEqual([]);
    // Liste d'attente : une route spécifiée non livrée porte `x-pending: '<tâche>'`. La livrer impose de retirer la marque ;
    // la tâche 3.6 rejoue ce contrôle contre l'OpenAPI générée par le serveur (15 § 6) et exige une liste vide.
    const waiting = [...specified].filter(([op]) => !delivered.includes(op));
    expect(waiting.filter(([, task]) => task === null).map(([op]) => op)).toEqual([]);
    expect(waiting.length).toBeGreaterThan(0);
  });

  test('la console arrête le flux sur une 404 de /api/events tant que la route n’est pas livrée, jamais après', () => {
    // Après 3.1, une 404 (routage cassé, reverse proxy) doit afficher le bandeau et reconnecter (dette notée dans l'ADR 0002).
    expect(STOP_ON_NOT_FOUND_DEFAULT).toBe(!delivered.includes('GET /api/events'));
  });
});
