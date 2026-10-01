// SPDX-License-Identifier: AGPL-3.0-only
// `@runtime/i18n` : surface publique de 21b § 2 (serveur, worker, scripts). La console et l'extension importent
// `@runtime/i18n/browser` (aucun accès disque).
export * from './browser.js';
export * from './node.js';
