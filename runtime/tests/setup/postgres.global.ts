// SPDX-License-Identifier: AGPL-3.0-only
// globalSetup du projet Vitest `integration` : un conteneur PostgreSQL par exécution, version PG_VERSION (défaut 16).
// La matrice 16/17/18 est jouée l'une après l'autre par scripts/test-integration.ts (VM Docker de 3,8 Go).
// Chaque fichier de test crée sa propre base dans ce conteneur (tests/helpers/pg.ts).
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
    pgVersion: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const version = process.env.PG_VERSION ?? '16';
  if (!/^\d+$/.test(version)) throw new Error(`PG_VERSION invalide : ${version} (attendu : 16, 17 ou 18)`);
  const container = await new PostgreSqlContainer(`postgres:${version}`).start();
  project.provide('pgAdminUrl', container.getConnectionUri());
  project.provide('pgVersion', version);
  return async () => {
    await container.stop();
  };
}
