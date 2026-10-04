// SPDX-License-Identifier: AGPL-3.0-only
// Itération par MCP (tâche 3.14, 19 §6) : fonctions pures du modèle de brouillon (version de schéma, diff, estimation, retour,
// porte de promotion). Aucune I/O.
export * from './schema-version.js';
export * from './diff.js';
export * from './estimate.js';
export * from './feedback.js';
export * from './promotion.js';

/** Durée de vie d'un brouillon, en jours (`DRAFT_TTL_DAYS`, à valider). */
export const DRAFT_TTL_DAYS = 30;
/** Versions gardées (`VERSIONS_KEEP`, à valider), plus toute version ayant été courante. */
export const VERSIONS_KEEP = 10;
/** Échantillons validés au moins avant une promotion (19 §6). */
export const PROMOTION_MIN_SAMPLES = 3;
