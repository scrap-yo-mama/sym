// SPDX-License-Identifier: AGPL-3.0-only
// Motifs de run dégradé tirés du profil (tâche 2.12, 19 §3, r4 R4) : `field_constant`, `pattern_shift`,
// `sentinel_values`, `duplicate_items`, `new_enum_value`. Aucune transition nouvelle : ils s'ajoutent aux raisons de
// 04 §6 et passent par les transitions 5 et 8 existantes. Informatifs, jamais notifiants seuls. Sans baseline VALIDÉE par
// l'utilisateur (r4 R3), les motifs qui comparent à la baseline (`pattern_shift`, `new_enum_value`) restent inactifs ; les
// contrôles absolus (constante, sentinelles, doublons) continuent. Seuils non mesurés (à valider au banc 2.8).
import type { RunProfile } from './profile.js';

export const DEGRADED_QUALITY_SIGNALS = ['field_constant', 'pattern_shift', 'sentinel_values', 'duplicate_items', 'new_enum_value'] as const;
export type DegradedQualitySignal = (typeof DEGRADED_QUALITY_SIGNALS)[number];

export const QUALITY_THRESHOLDS = Object.freeze({
  /** Items minimum pour juger un run (en dessous, aucun motif). */
  minItems: 5,
  sentinelRate: 0.2,
  duplicateRate: 0.1,
  /** Baisse de la part du motif dominant de la baseline. */
  patternDrop: 0.3,
  /** Un champ est une énumération si la baseline a au plus 10 valeurs distinctes, pour au moins deux fois plus d'items. */
  enumMaxDistinct: 10,
});

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `constant_ok: true` par champ, décidé à la validation du schéma (devise `EUR`), et champs requis. */
function schemaFlags(schema: unknown): { required: Set<string>; constantOk: Set<string> } {
  const required = new Set<string>(isRecord(schema) && Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter((r): r is string => typeof r === 'string') : []);
  const constantOk = new Set<string>();
  const props = isRecord(schema) && isRecord(schema['properties']) ? schema['properties'] : {};
  for (const [k, v] of Object.entries(props)) if (isRecord(v) && v['constant_ok'] === true) constantOk.add(k);
  return { required, constantOk };
}

export function degradedQualitySignals(profile: RunProfile, baseline: RunProfile | null, schema: unknown): DegradedQualitySignal[] {
  const t = QUALITY_THRESHOLDS;
  if (profile.items < t.minItems) return [];
  const { required, constantOk } = schemaFlags(schema);
  const found = new Set<DegradedQualitySignal>();
  for (const [name, f] of Object.entries(profile.fields)) {
    const b = baseline?.fields[name];
    if (f.constant && !constantOk.has(name) && (b === undefined ? required.has(name) : !b.constant)) found.add('field_constant');
    if (f.sentinel_rate >= t.sentinelRate && (b === undefined ? required.has(name) : f.sentinel_rate > b.sentinel_rate + 0.1)) found.add('sentinel_values');
    if (b === undefined) continue;
    if (b.top_pattern !== null && (b.patterns[b.top_pattern] ?? 0) - (f.patterns[b.top_pattern] ?? 0) >= t.patternDrop) found.add('pattern_shift');
    if (!f.personal && !f.suspected_personal && b.top !== undefined && f.top !== undefined && b.distinct > 0 && b.distinct <= t.enumMaxDistinct && b.distinct * 2 <= baseline!.items) {
      const known = new Set(b.top.map((x) => JSON.stringify(x.value)));
      if (f.top.some((x) => !known.has(JSON.stringify(x.value)))) found.add('new_enum_value');
    }
  }
  if (profile.duplicate_rate >= t.duplicateRate && (baseline === null || profile.duplicate_rate > baseline.duplicate_rate + 0.05)) found.add('duplicate_items');
  return DEGRADED_QUALITY_SIGNALS.filter((s) => found.has(s));
}
