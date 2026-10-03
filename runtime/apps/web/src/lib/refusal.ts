// SPDX-License-Identifier: AGPL-3.0-only
// Classes de résultat d'un refus du site (403, défi, robots.txt, défi en tunnel) : un refus mène à l'arrêt volontaire, jamais à
// un autre réseau (X3, X4). Copie de lecture des classes bloquantes du cœur (`BLOCKING_CLASSES`), comparée par
// tests/console-refusal-classes.unit.test.ts : la console ne dépend pas de `@runtime/core`. Fonctions pures, sans I/O, sans alias.

export const REFUSAL_RESULTS: readonly string[] = Object.freeze(['forbidden', 'blocked_by_protection', 'robots_disallowed', 'challenge_in_tunnel']);

/** Vrai si la classe de résultat d'un essai (ou d'un élagage) est un refus du site. */
export const isRefusal = (result: string | null | undefined): boolean => typeof result === 'string' && REFUSAL_RESULTS.includes(result);
