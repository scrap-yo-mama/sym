// SPDX-License-Identifier: AGPL-3.0-only
// Tests du nœud sur de vrais Chromium 153 (pool, tâche 1.1) : un fichier à la fois, sans parallélisme (processus réels).
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['src/**/*.chromium.test.ts'], testTimeout: 300_000, hookTimeout: 60_000, fileParallelism: false } });
