// Modèle, stratégies, DSL, machine à états, classifieur, net (garde SSRF) : sans I/O. Squelette tâche 0.1.
export const PACKAGE_NAME = '@runtime/core';

export function assertNever(value: never): never {
  throw new Error(`Valeur inattendue : ${String(value)}`);
}
