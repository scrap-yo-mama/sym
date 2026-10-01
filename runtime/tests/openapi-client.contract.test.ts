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
  return new Map([...parseOperations(yaml)].map(([op, parsed]) => [op, parsed.pending]));
}

type ParsedOperation = { pending: string | null; security: string[] | null };

/** Schémas de sécurité posés sur une opération (`security: []` → liste vide ; absent → null, soit la sécurité par défaut). */
function parseOperations(yaml: string): Map<string, ParsedOperation> {
  const out = new Map<string, ParsedOperation>();
  let path: string | null = null;
  let current: string | null = null;
  let inPaths = false;
  let inSecurity = false;
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
      out.set(current, { pending: null, security: null });
      inSecurity = false;
      continue;
    }
    const operation = current ? out.get(current) : undefined;
    if (!operation) continue;
    const pendingMatch = /^ {6}x-pending: '(\d+\.\d+[a-z]?)'$/.exec(line);
    if (pendingMatch) operation.pending = pendingMatch[1] ?? null;
    if (line === '      security: []') {
      operation.security = [];
      inSecurity = false;
    } else if (line === '      security:') {
      operation.security = [];
      inSecurity = true;
    } else if (inSecurity) {
      const scheme = /^ {8}- (\w+): \[\]$/.exec(line);
      if (scheme) operation.security?.push(scheme[1] ?? '');
      else inSecurity = false;
    }
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

  test('assert_openapi_specified_auth_matches_registry : le mode d’authentification spécifié est celui du registre', () => {
    // Sécurité par défaut de la spec : session OU clé d'API. Une route réservée à la session ou à l'appareil ne doit
    // jamais annoncer une clé d'API (13 § 8 : jamais de scope d'administration).
    const parsed = parseOperations(yaml);
    const expectedSchemes: Record<string, string[]> = {
      session: ['sessionCookie'],
      session_or_key: ['apiKey', 'sessionCookie'],
      extension: ['deviceToken'],
    };
    const mismatches: string[] = [];
    for (const route of ROUTES) {
      const op = `${route.method} ${route.url.replace(/:(\w+)/g, '{$1}')}`;
      const declared = parsed.get(op)?.security;
      const actual = (declared ?? ['sessionCookie', 'apiKey']).slice().sort();
      if (route.auth === 'public') {
        // `security: []`, ou un jeton propre (`/metrics`) ; jamais une identité d'utilisateur.
        if (actual.includes('sessionCookie') || actual.includes('apiKey')) mismatches.push(`${op} : public mais spécifiée avec ${actual.join('+')}`);
      } else if (JSON.stringify(actual) !== JSON.stringify(expectedSchemes[route.auth])) {
        mismatches.push(`${op} : registre ${route.auth}, spec ${actual.join('+') || '(aucune)'}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('le contrôle du mode d’authentification détecte une route de session annoncée avec une clé d’API', () => {
    const drifted = yaml.replace(
      /( {2}\/api\/admin\/tunnels:\n {4}get:\n {6}operationId: listAdminTunnels\n) {6}security:\n {8}- sessionCookie: \[\]\n/,
      '$1',
    );
    expect(drifted).not.toBe(yaml);
    expect(parseOperations(drifted).get('GET /api/admin/tunnels')?.security).toBeNull();
    expect(parseOperations(yaml).get('GET /api/admin/tunnels')?.security).toEqual(['sessionCookie']);
  });

  test('la console arrête le flux sur une 404 de /api/events tant que la route n’est pas livrée, jamais après', () => {
    // Après 3.1, une 404 (routage cassé, reverse proxy) doit afficher le bandeau et reconnecter (dette notée dans l'ADR 0002).
    expect(STOP_ON_NOT_FOUND_DEFAULT).toBe(!delivered.includes('GET /api/events'));
  });
});

describe('OpenAPI spécifiée : YAML sain', () => {
  // Un analyseur tolérant (openapi-typescript) accepte une apostrophe non fermée ou un schéma en double et garde la dernière
  // définition : la faute passe alors inaperçue (motif de `deviceId` perdu, ancien schéma `Version` resté dans le fichier).
  const spec = readFileSync(SPEC_URL, 'utf8').split('\n');

  test('aucune chaîne entre apostrophes ouverte sans être fermée sur sa ligne', () => {
    const unclosed = spec
      .map((line, at) => ({ line, at: at + 1 }))
      .filter(({ line }) => {
        // Valeur qui commence par une apostrophe (`clé: '…'`, `- '…'`, `[a, '…']`) : elle doit se fermer sur la même ligne.
        const value = /^\s*(?:- )?(?:[\w$./{}-]+:\s*)?(['[].*)$/.exec(line)?.[1];
        return value !== undefined && value.includes("'") && (value.replace(/''/g, '').match(/'/g) ?? []).length % 2 === 1;
      });
    expect(unclosed).toEqual([]);
  });

  test('chaque schéma de components.schemas est défini une seule fois', () => {
    const start = spec.indexOf('  schemas:');
    expect(start).toBeGreaterThan(0);
    const names: string[] = [];
    for (const line of spec.slice(start + 1)) {
      if (/^\S/.test(line) || /^ {2}\S/.test(line)) break;
      const match = /^ {4}([A-Za-z0-9_]+):\s*$/.exec(line);
      if (match) names.push(match[1] ?? '');
    }
    expect(names.length).toBeGreaterThan(50);
    expect(names.filter((name, at) => names.indexOf(name) !== at)).toEqual([]);
  });

  test('le schéma Version est celui que sert GET /api/version (16 § 3) : server, schema, min_extension, mcp_spec', () => {
    const text = spec.join('\n');
    expect(text).not.toContain('required: [version, schema_version]');
    expect(text).toMatch(/ {4}Version:\n(?: {6}.*\n)*? {6}required: \[server, schema, min_extension, mcp_spec\]/);
  });
});

describe('OpenAPI spécifiée : ré-authentification des opérations sensibles (13 § 5, 7.5.1)', () => {
  const lines = readFileSync(SPEC_URL, 'utf8').split('\n');
  /** Bloc YAML qui commence à la ligne `head` (indentation comprise) et s'arrête à la ligne suivante de même retrait. */
  function block(head: RegExp): string {
    const start = lines.findIndex((l) => head.test(l));
    expect(start, String(head)).toBeGreaterThan(0);
    const indent = /^ */.exec(lines[start] ?? '')?.[0].length ?? 0;
    const end = lines.findIndex((l, at) => at > start && l.trim() !== '' && (/^ */.exec(l)?.[0].length ?? 0) <= indent);
    return lines.slice(start, end).join('\n');
  }

  test('assert_reauth_contract : mot de passe actuel facultatif pour un compte OIDC seul, 403 reauth_required et reauth_failed documentés', () => {
    const schemas = ['ApiKeyCreate', 'ExtensionPairingCodeRequest', 'PasswordConfirmation', 'PasswordAndCode', 'TwoFactorDisable', 'OidcLinkRequest', 'OwnerTransferRequest'];
    for (const name of schemas) {
      const text = block(new RegExp(`^ {4}${name}:\\s*$`));
      const required = /^ {6}required: \[(.*)\]$/m.exec(text)?.[1] ?? '';
      expect(required, name).not.toMatch(/current_?[pP]assword/);
      expect(text, name).toMatch(/\$ref: '#\/components\/schemas\/CurrentPassword'/);
    }
    const field = block(/^ {4}CurrentPassword:\s*$/);
    expect(field).toContain('current_password_required');
    expect(field).toContain('reauth_required');
    const reauth = block(/^ {4}ReauthError:\s*$/);
    for (const code of ['reauth_failed', 'reauth_required']) expect(reauth).toContain(code);
    const operations = ['createApiKey', 'createExtensionPairingCode', 'enrollTwoFactor', 'regenerateBackupCodes', 'disableTwoFactor', 'startOidcLink', 'transferOwnership'];
    for (const op of operations) {
      // De `operationId` à la méthode ou au chemin suivant.
      const at = lines.findIndex((l) => l === `      operationId: ${op}`);
      expect(at, op).toBeGreaterThan(0);
      const end = lines.findIndex((l, i) => i > at && /^ {0,4}\S/.test(l));
      const body = lines.slice(at, end).join('\n');
      expect(body, op).toMatch(/'403':\n {10}\$ref: '#\/components\/responses\/ReauthError'/);
      expect(body, op).toMatch(/'429':/);
      expect(body, op).toMatch(/'400':/);
      expect(body, op).not.toMatch(/summary: .*ré-authentification par mot de passe/);
    }
  });
});
