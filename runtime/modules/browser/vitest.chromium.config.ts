// SPDX-License-Identifier: AGPL-3.0-only
// Bout en bout sur vrai Chromium 153 (tâche 2.3 : assert_cdp_client_compat au travers des relais) : un fichier à la fois.
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/**/*.chromium.test.ts'], testTimeout: 300_000, hookTimeout: 180_000, fileParallelism: false } });
