// SPDX-License-Identifier: AGPL-3.0-only
// Limites de l'interpréteur (04b § 2, `limits`) : taille, profondeur, nombre d'items, temps. Tout dépassement lève `DslError`.
import { DslError } from './errors.js';

export interface DslLimits {
  /** Taille maximale de la réponse, en octets (`limits.max_response_bytes`). */
  maxResponseBytes: number;
  /** Profondeur maximale d'un document JSON (`limits.max_depth`). */
  maxDepth: number;
  /** Durée maximale d'une extraction, en ms (`limits.timeout_ms`). */
  timeoutMs: number;
  /** Nombre maximal d'enregistrements extraits d'une source. */
  maxItems: number;
  /** Nombre maximal de noeuds JSON d'un document (après expansion des références d'un blob). */
  maxNodes: number;
  /** Longueur maximale d'une chaîne d'un document JSON ou d'un texte extrait (caractères). */
  maxStringLength: number;
  /** Longueur maximale d'un tableau d'un document JSON. */
  maxArrayLength: number;
  /** Profondeur maximale de l'arbre HTML. */
  maxHtmlDepth: number;
}

export const DEFAULT_DSL_LIMITS: DslLimits = {
  maxResponseBytes: 5_000_000,
  maxDepth: 32,
  timeoutMs: 15_000,
  maxItems: 10_000,
  maxNodes: 500_000,
  maxStringLength: 1_000_000,
  maxArrayLength: 50_000,
  maxHtmlDepth: 256,
};

/** Plafonds que ni une stratégie ni un appelant ne peuvent dépasser. */
export const HARD_DSL_LIMITS: DslLimits = {
  maxResponseBytes: 20_000_000,
  maxDepth: 64,
  timeoutMs: 60_000,
  maxItems: 50_000,
  maxNodes: 2_000_000,
  maxStringLength: 4_000_000,
  maxArrayLength: 100_000,
  maxHtmlDepth: 512,
};

/** Borne de longueur d'un chemin JSONPath, d'un sélecteur CSS, d'un motif. */
export const MAX_PATH_LENGTH = 1_000;
export const MAX_SELECTOR_LENGTH = 300;

export interface SpecLimitsInput {
  max_response_bytes?: number;
  max_depth?: number;
  timeout_ms?: number;
}

/** Limites effectives : défauts, puis `spec.limits`, puis surcharges de l'appelant, le tout plafonné par `HARD_DSL_LIMITS`. */
export function resolveLimits(specLimits?: SpecLimitsInput, overrides: Partial<DslLimits> = {}): DslLimits {
  const merged: DslLimits = { ...DEFAULT_DSL_LIMITS };
  if (specLimits?.max_response_bytes !== undefined) merged.maxResponseBytes = specLimits.max_response_bytes;
  if (specLimits?.max_depth !== undefined) merged.maxDepth = specLimits.max_depth;
  if (specLimits?.timeout_ms !== undefined) merged.timeoutMs = specLimits.timeout_ms;
  Object.assign(merged, overrides);
  const out = { ...merged };
  for (const key of Object.keys(HARD_DSL_LIMITS) as (keyof DslLimits)[]) {
    const v = out[key];
    out[key] = Number.isFinite(v) && v > 0 ? Math.min(v, HARD_DSL_LIMITS[key]) : DEFAULT_DSL_LIMITS[key];
  }
  return out;
}

/** Échéance : `check()` lève `timeout` une fois le délai écoulé. Appelée entre deux étapes (un appel synchrone ne s'interrompt pas). */
export class Deadline {
  readonly #at: number;
  readonly #now: () => number;
  constructor(ms: number, now: () => number = Date.now) {
    this.#now = now;
    this.#at = now() + ms;
  }
  check(): void {
    if (this.#now() > this.#at) throw new DslError('timeout', 'extraction interrompue : délai dépassé');
  }
}

export function assertResponseSize(body: string, limits: DslLimits): void {
  // Une chaîne UTF-16 pèse au plus 3 octets UTF-8 par unité : on évite de mesurer un texte énorme.
  if (body.length > limits.maxResponseBytes || Buffer.byteLength(body, 'utf8') > limits.maxResponseBytes) {
    throw new DslError('response_too_large', `réponse refusée : plus de ${limits.maxResponseBytes} octets`);
  }
}

/** Parcours itératif : profondeur, nombre de noeuds, longueur des tableaux et des chaînes. Aucune récursion (pas de dépassement de pile). */
export function assertJsonWithinLimits(root: unknown, limits: DslLimits): void {
  let nodes = 0;
  const stack: [unknown, number][] = [[root, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop() as [unknown, number];
    if (typeof value === 'string') {
      if (value.length > limits.maxStringLength) throw new DslError('value_too_large', 'document refusé : chaîne trop longue');
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    nodes += 1;
    if (nodes > limits.maxNodes) throw new DslError('too_many_nodes', `document refusé : plus de ${limits.maxNodes} noeuds`);
    if (depth > limits.maxDepth) throw new DslError('depth_exceeded', `document refusé : profondeur > ${limits.maxDepth}`);
    if (Array.isArray(value)) {
      if (value.length > limits.maxArrayLength) throw new DslError('too_many_items', `document refusé : tableau de plus de ${limits.maxArrayLength} éléments`);
      for (const child of value) stack.push([child, depth + 1]);
    } else {
      for (const child of Object.values(value)) stack.push([child, depth + 1]);
    }
  }
}

/** JSON.parse borné : taille avant analyse, forme après. */
export function parseJsonBounded(text: string, limits: DslLimits): unknown {
  assertResponseSize(text, limits);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new DslError('invalid_json', 'JSON invalide', { cause });
  }
  assertJsonWithinLimits(value, limits);
  return value;
}
