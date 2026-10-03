// SPDX-License-Identifier: AGPL-3.0-only
// Données de la simulation sous `vite` (développement seulement, jamais dans dist/). Valeurs factices, sans rapport avec un
// déploiement : l'instance démarre sans admin, /setup attend ce jeton ; le code TOTP de la simulation est MOCK_TOTP_CODE.
import type { MockAuthOptions } from './mock-auth.js';

export const DEV_AUTH_FIXTURE: MockAuthOptions = { bootstrapToken: 'symb_boot_dev_factice' };
