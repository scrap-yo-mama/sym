// SPDX-License-Identifier: AGPL-3.0-only
// globalSetup des tests d'intégration de la passerelle : un conteneur PostgreSQL par exécution (PG_VERSION, défaut 16),
// une base jetable par fichier de test (test/helpers/harness.ts). Même protocole que @sym-browser/db.
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const version = process.env.PG_VERSION ?? '16';
  if (!/^(16|17|18)$/.test(version)) throw new Error(`PG_VERSION invalide : ${version} (attendu : 16, 17 ou 18)`);
  const container = await new PostgreSqlContainer(`postgres:${version}`).start();
  project.provide('pgAdminUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
