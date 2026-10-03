// SPDX-License-Identifier: AGPL-3.0-only
// globalSetup du quickstart rejoué (tâche 3.8) : un PostgreSQL par exécution (Testcontainers, `PG_VERSION`, défaut 16), ou
// un serveur déjà démarré donné par `SYMB_TEST_PG_URL` (URL d'un rôle qui peut créer des bases ; utile quand l'utilisateur
// non root qu'exigent les tests Chromium n'a pas accès à Docker). Une base jetable par instance (tests/helpers).
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env.SYMB_TEST_PG_URL;
  if (external) {
    project.provide('pgAdminUrl', external);
    return async () => undefined;
  }
  const version = process.env.PG_VERSION ?? '16';
  if (!/^(16|17|18)$/.test(version)) throw new Error(`PG_VERSION invalide : ${version} (attendu : 16, 17 ou 18)`);
  const container = await new PostgreSqlContainer(`postgres:${version}`).start();
  project.provide('pgAdminUrl', container.getConnectionUri());
  return async () => {
    await container.stop();
  };
}
