// SPDX-License-Identifier: AGPL-3.0-only
// Contenu minimal à l'enquête (tâche 2.12, 19 §3, r4 R5) : en plus de N = 3 sorties conformes, aucun champ REQUIS n'est
// constant, vide ou en sentinelles sur l'ensemble de ces sorties ; sinon classe `extraction`, couple suivant.
// `constant_ok: true` par champ (décidé à la validation du schéma, devise `EUR`) admet une constante.
import { SENTINEL_VALUES } from './profile.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export type MinimalContentResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure_class: 'extraction'; readonly detail: 'minimal_content'; readonly field: string; readonly reason: 'sentinel' | 'constant' };

export function minimalContentCheck(outputs: readonly (readonly unknown[])[], schema: unknown): MinimalContentResult {
  const required = isRecord(schema) && Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter((r): r is string => typeof r === 'string') : [];
  const props = isRecord(schema) && isRecord(schema['properties']) ? schema['properties'] : {};
  const items = outputs.flat();
  if (items.length === 0) return { ok: true };
  for (const field of required) {
    const values = items.map((it) => (isRecord(it) ? it[field] : undefined));
    // Vide ou sentinelle sur tous les items (null compris).
    if (values.every((v) => v === undefined || v === null || (typeof v === 'string' && SENTINEL_VALUES.includes(v.trim())))) {
      return { ok: false, failure_class: 'extraction', detail: 'minimal_content', field, reason: 'sentinel' };
    }
    const sub = props[field];
    if (isRecord(sub) && sub['constant_ok'] === true) continue;
    // Constante jugée DANS chaque sortie de plusieurs items (une API à un seul enregistrement rejouée 3 fois sur la même
    // entrée rend naturellement 3 fois la même valeur : ce n'est pas un défaut).
    const multi = outputs.filter((o) => o.length >= 2);
    if (multi.length > 0 && multi.every((o) => new Set(o.map((it) => JSON.stringify(isRecord(it) ? it[field] : undefined))).size === 1)) {
      return { ok: false, failure_class: 'extraction', detail: 'minimal_content', field, reason: 'constant' };
    }
  }
  return { ok: true };
}
