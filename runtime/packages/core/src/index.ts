// Modèle, stratégies, DSL, machine à états, classifieur : sans I/O. Squelette tâche 0.1.
// La garde SSRF (I/O réseau, undici) est exportée à part : `@runtime/core/net` (tâche 0.7).
export const PACKAGE_NAME = '@runtime/core';

export function assertNever(value: never): never {
  throw new Error(`Valeur inattendue : ${String(value)}`);
}

export * from './crypto/index.js';
