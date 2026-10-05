// SPDX-License-Identifier: AGPL-3.0-only
// Enquête (tâche 2.1, 04 §4) : reconnaissance, proposition du schéma de sortie, plan d'essai par coût croissant,
// élagage, plafonds. Logique pure ; l'I/O (réseau, LLM, base) est dans le worker. Exporté en sous-chemin
// `@runtime/core/investigation`.
export * from './plan.js';
export * from './recon.js';
export * from './proposal.js';
export * from './candidates.js';
export * from './trials.js';
export * from './events.js';
export * from './ambiguity.js';
export * from './milestones.js';
export * from './html-compile.js';
export * from './dom.js';
export * from './fidelity.js';
export * from './sources.js';
export * from './schema-validation.js';
export * from './field-fix.js';
export * from './data-quality.js';
