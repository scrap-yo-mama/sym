// SPDX-License-Identifier: AGPL-3.0-only
// Suite de parité à trois fournisseurs (tâche 4.4, `pnpm test:parity`) : vrais Chromium, PostgreSQL jetable (Docker), un fichier.
// Hors des projets de `vitest.config.ts` : jouée sous verrou de test, jamais par `pnpm test`.
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/browser-parity/*.parity.test.ts'], testTimeout: 180_000, hookTimeout: 300_000, fileParallelism: false } });
