// SPDX-License-Identifier: AGPL-3.0-only
// Source d'une version de stratégie (tâche 2.10, 18 §2, §4.6) : ce que l'utilisateur veut et comment le chercher — la
// demande, l'empreinte du schéma de sortie, l'enquête et ses décisions, et les règles appliquées AVEC leur version et leur
// empreinte. Le compilé (DSL, script, prompt figé E4-E6) est rejoué sans relire les règles courantes.
import { createHash } from 'node:crypto';
import type { ResolvedRules, RuleLevel } from './resolve.js';
import type { SkillRead } from './skills.js';

export type StrategySourceReason = 'investigation' | 'repair' | 'recompile' | 'import';
export type RuleLoad = 'injected' | 'skill_read' | 'embedded' | 'truncated';

export type StrategySource = {
  readonly request: { readonly description: string; readonly url: string; readonly example_output_ref: string | null };
  readonly output_schema_sha256: string;
  readonly investigation_id: string | null;
  /** Événements d'enquête qui portent les décisions (identifiants de `investigation_events`). */
  readonly decisions: readonly string[];
  readonly rules: readonly { readonly name: string; readonly version: number; readonly sha256: string; readonly level: RuleLevel }[];
  readonly reason: StrategySourceReason;
};

/** Ligne de `strategy_version_rules`. */
export type StrategyRuleRow = {
  readonly rule_file_id: string;
  readonly name?: string;
  readonly version: number;
  readonly sha256: string;
  readonly level: RuleLevel;
  readonly loaded: RuleLoad;
};

/** Empreinte stable d'un JSON (clés triées). */
export function jsonSha256(value: unknown): string {
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
  return createHash('sha256').update(JSON.stringify(canon(value) ?? null)).digest('hex');
}

/**
 * Lignes de la source : règles injectées (ou embarquées dans un prompt figé E4-E6), skills lus, règles retirées par le
 * plafond (`truncated`, pour l'aperçu et l'audit ; elles n'entrent pas dans `source.rules`).
 */
export function sourceRuleRows(resolved: Pick<ResolvedRules, 'rules' | 'skills' | 'truncated'>, reads: readonly SkillRead[], options: { readonly embedded?: boolean } = {}): StrategyRuleRow[] {
  const rows: StrategyRuleRow[] = [];
  for (const r of resolved.rules) rows.push({ rule_file_id: r.file_id, name: r.name, version: r.version, sha256: r.sha256, level: r.level, loaded: options.embedded === true ? 'embedded' : 'injected' });
  for (const read of reads) {
    const skill = resolved.skills.find((s) => s.name === read.name && s.version === read.version);
    if (skill !== undefined) rows.push({ rule_file_id: skill.file_id, name: skill.name, version: skill.version, sha256: skill.sha256, level: skill.level, loaded: 'skill_read' });
  }
  for (const r of resolved.truncated) rows.push({ rule_file_id: r.file_id, name: r.name, version: r.version, sha256: r.sha256, level: r.level, loaded: 'truncated' });
  return rows;
}

/** `source.rules` : chaque règle injectée et chaque skill lu (18 §4.10, assert_strategy_source_recorded). */
export function sourceRules(rows: readonly StrategyRuleRow[]): StrategySource['rules'] {
  return rows.filter((r) => r.loaded !== 'truncated').map((r) => ({ name: r.name ?? '', version: r.version, sha256: r.sha256, level: r.level }));
}

/** `compiled_with.rules` : `nom@version#sha256` (19b §1). */
export function compiledWithRules(rows: readonly StrategyRuleRow[]): string[] {
  return rows.filter((r) => r.loaded !== 'truncated').map((r) => `${r.name ?? r.rule_file_id}@${r.version}#${r.sha256}`);
}
