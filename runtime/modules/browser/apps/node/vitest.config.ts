// SPDX-License-Identifier: AGPL-3.0-only
// Tests du nœud sans navigateur (`pnpm test`). Les tests sur de vrais Chromium (`*.chromium.test.ts`) exigent un utilisateur
// non root et les espaces de noms utilisateur : ils tournent à part (`pnpm test:chromium`, vitest.chromium.config.ts).
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['src/**/*.test.ts'], exclude: [...configDefaults.exclude, 'src/**/*.chromium.test.ts'] } });
