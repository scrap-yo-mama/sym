// SPDX-License-Identifier: AGPL-3.0-only
// Nœud de SYM Browser comme bibliothèque (tâche 5.1) : la passerelle, point d'entrée de l'image pour les trois rôles
// (`SYMB_MODE`), assemble le pool de Chromium et le battement du nœud en mode `all` et `node`.
export * from './engine.js';
export * from './pool/index.js';
export { HEARTBEAT_DEFAULTS, startHeartbeat, type HeartbeatOptions } from './sessions/heartbeat.js';
