// SPDX-License-Identifier: AGPL-3.0-only
// Tests de la racine du module seulement (frontière, hygiène, environnement Claude, bout en bout) : chaque paquet de apps/ et
// packages/ lance les siens (`pnpm --filter "./modules/browser/**" test`). Les tests sur vrai Chromium (`*.chromium.test.ts`)
// ont leur propre configuration : `pnpm --filter @sym-browser/module test:chromium` (utilisateur non root).
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/**/*.test.ts', 'fixtures/**/*.test.ts'], exclude: ['**/node_modules/**', 'tests/**/*.chromium.test.ts'], testTimeout: 60_000 } });
