// SPDX-License-Identifier: AGPL-3.0-only
// Console et droits (tâche 3.8, 13.2) : la console pilote ses écrans et ses routes par `can()`, dont le résultat arrive dans
// `GET /api/me` (`permissions`). Elle ne recopie pas la matrice des rôles ; ce test garde les deux seules copies qui existent,
// l'énumération de l'OpenAPI et les fixtures des tests de la console, alignées sur `packages/core/src/auth/roles.ts`.
import { readFileSync } from 'node:fs';
import { can, PERMISSIONS, ROLES, type Permission } from '@runtime/core';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { ROLE_PERMISSIONS } from '../apps/web/src/testing/permissions.ts';

const spec = parse(readFileSync(new URL('../packages/client/openapi/openapi.yaml', import.meta.url), 'utf8')) as {
  components: { schemas: { Permission: { enum: string[] }; Me: { required: string[]; properties: Record<string, unknown> } } };
};

describe('assert_me_permissions_from_can : la console lit can(), elle ne le recopie pas', () => {
  test('l’énumération Permission de l’OpenAPI est exactement l’ensemble des permissions de packages/core', () => {
    expect([...spec.components.schemas.Permission.enum].sort()).toEqual(Object.keys(PERMISSIONS).sort());
  });

  test('`Me` annonce les permissions, l’état de la 2FA et l’enrôlement exigé', () => {
    const { required, properties } = spec.components.schemas.Me;
    for (const field of ['permissions', 'mfaEnabled', 'mfaEnrollmentRequired']) {
      expect(required, field).toContain(field);
      expect(properties, field).toHaveProperty(field);
    }
  });

  test('les fixtures de la console servent, pour chaque rôle, exactement ce que can() accorde', () => {
    for (const role of ROLES) {
      const expected = (Object.keys(PERMISSIONS) as Permission[]).filter((permission) => can(role, permission));
      expect(ROLE_PERMISSIONS[role], role).toEqual(expected);
    }
  });
});
