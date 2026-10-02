// SPDX-License-Identifier: AGPL-3.0-only
// Tests de la racine du module seulement (frontière, hygiène, environnement Claude) : chaque paquet de apps/ et packages/
// lance les siens (`pnpm --filter "./modules/browser/**" test`).
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/**/*.test.ts', 'fixtures/**/*.test.ts'], testTimeout: 60_000 } });
