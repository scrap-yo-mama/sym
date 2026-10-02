// SPDX-License-Identifier: AGPL-3.0-only
// Modèle, stratégies, DSL, machine à états, classifieur : sans I/O. Squelette tâche 0.1.
// La garde SSRF (I/O réseau, undici) est exportée à part : `@runtime/core/net` (tâche 0.7).
export const PACKAGE_NAME = '@runtime/core';

export function assertNever(value: never): never {
  throw new Error(`Valeur inattendue : ${String(value)}`);
}

export * from './crypto/index.js';
export * from './auth/index.js';
export type * from './agent/engine.js';
export * from './agent/tools.js';
export * from './agent/step-wire.js';
export * from './agent/step-session.js';
export * from './agent/execution-network.js';
export * from './agent/specs.js';
export * from './agent/compile.js';
export * from './agent/label-extract.js';
export * from './agent/page-text.js';
export * from './model/index.js';
export * from './schema/index.js';
export * from './dsl/index.js';
export * from './status/index.js';
export * from './run/index.js';
export * from './pacing/index.js';
export * from './schedule/index.js';
export * from './webhook/index.js';
export * from './alerts/index.js';
export * from './observability/index.js';
export * from './privacy/index.js';
export * from './repair/index.js';
export * from './memory/index.js';
export * from './quality/index.js';
export * from './agent/phases.js';
export type * from './sandbox/index.js';
export * from './version.js';
export * from './config/env-catalog.js';
