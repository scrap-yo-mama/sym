// SPDX-License-Identifier: AGPL-3.0-only
// Module d'accès (tâche 1.11, 17) : rapport d'accès (étape 0 de l'enquête), signaux d'accès, 402, `access_policy`,
// User-Agent avec contact d'instance ; lignes `Sitemap` d'un robots.txt lu comme une page d'information (D-91).
// Exporté en sous-chemin `@runtime/core/access` (lecture par la session réseau, comme `@runtime/core/exec`).
export * from './robots.js';
export * from './signals.js';
export * from './policy.js';
export * from './identity.js';
export * from './report.js';
