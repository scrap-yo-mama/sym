// SPDX-License-Identifier: AGPL-3.0-only
// Règles embarquées dans un prompt figé E4-E6 (tâche 2.10, 18 §4.5, INV12) : la spec de la stratégie ne garde que des
// RÉFÉRENCES (`nom@version#sha256`, niveau ; skills listés pour E6), jamais le texte, car `strategy_versions` est lisible
// des membres quand l'API est partagée d'instance. Au run (essai d'enquête comme rejeu), le texte est reconstruit depuis
// `rule_file_versions` lu sous l'identité du propriétaire de l'API, chaque fichier vérifié par son `sha256` : la même
// entrée donne le même prompt, et une règle modifiée depuis ne change rien avant recompilation. Un écart (fichier
// absent, illisible pour ce propriétaire, empreinte différente) : rien n'est injecté. `read_skill` ne sert que les skills
// référencés, à leur version épinglée, empreinte vérifiée.
import type { EmbeddedRules } from '../agent/specs.js';
import { EMBEDDED_REF_RE } from '../agent/specs.js';
import { ruleSha256, type RuleKind } from './format.js';
import { renderRulesPrompt, type ResolvedRule, type ResolvedRules, type RuleLevel } from './resolve.js';
import type { SkillFile } from './skills.js';

/** Version d'un fichier lue en base pour reconstruire un prompt embarqué. */
export type EmbeddedFile = { readonly name: string; readonly kind: RuleKind; readonly version: number; readonly sha256: string; readonly content: string; readonly description: string };

export type EmbeddedRef = { readonly name: string; readonly version: number; readonly sha256: string };

/** `nom@version#sha256` → parties ; `null` si illisible. */
export function parseEmbeddedRef(ref: string): EmbeddedRef | null {
  const m = EMBEDDED_REF_RE.exec(ref);
  return m === null ? null : { name: m[1]!, version: Number(m[2]), sha256: m[3]! };
}

const refOf = (r: { readonly name: string; readonly version: number; readonly sha256: string }) => `${r.name}@${r.version}#${r.sha256}`;

/** Références à embarquer (ensemble résolu au rôle `embedded`) ; skills listés seulement pour un moteur qui a `read_skill` (E6). */
export function embeddedRulesOf(resolved: Pick<ResolvedRules, 'rules' | 'skills' | 'skillsWithoutDescription'>, options: { readonly skills: boolean }): EmbeddedRules {
  const without = new Set(resolved.skillsWithoutDescription);
  return {
    rules: resolved.rules.map((r) => ({ ref: refOf(r), level: r.level })),
    skills: options.skills ? resolved.skills.map((s) => ({ ref: refOf(s), described: !without.has(s.name) })) : [],
  };
}

/** Toutes les références d'une spec (règles puis skills). */
export function embeddedRefs(embedded: EmbeddedRules): string[] {
  return [...embedded.rules.map((r) => r.ref), ...embedded.skills.map((s) => s.ref)];
}

export type EmbeddedPrompt =
  | { readonly ok: true; readonly text: string; readonly skills: readonly SkillFile[] }
  /** Écart : références introuvables ou empreinte différente ; rien n'est injecté. */
  | { readonly ok: false; readonly missing: readonly string[] };

/** Reconstruit le prompt embarqué (bloc <trusted_rules> et liste des skills) depuis les fichiers lus, empreintes vérifiées. */
export function renderEmbeddedRules(embedded: EmbeddedRules, files: readonly EmbeddedFile[]): EmbeddedPrompt {
  const missing: string[] = [];
  const find = (ref: string, kind: 'rule' | 'skill'): EmbeddedFile | undefined => {
    const r = parseEmbeddedRef(ref);
    const file = r === null ? undefined : files.find((f) => f.name === r.name && f.version === r.version && f.sha256 === r.sha256 && (kind === 'skill' ? f.kind === 'skill' : f.kind !== 'skill'));
    // Contenu vérifié : la base garantit l'empreinte, le code la recalcule (une ligne modifiée à la main n'est jamais servie).
    if (file === undefined || ruleSha256(file.content) !== file.sha256) {
      missing.push(ref);
      return undefined;
    }
    return file;
  };
  const resolved = (f: EmbeddedFile, level: RuleLevel): ResolvedRule => ({
    file_id: '',
    owner_id: null,
    visibility: 'private',
    kind: f.kind,
    name: f.name,
    description: f.description,
    applies_to: [],
    target_api_ids: [],
    version: f.version,
    sha256: f.sha256,
    content: f.content,
    level,
    ref: `${f.name}@${f.version}`,
    tokens: 0,
  });
  const rules: ResolvedRule[] = [];
  for (const r of embedded.rules) {
    const f = find(r.ref, 'rule');
    if (f !== undefined) rules.push(resolved(f, r.level));
  }
  const skills: ResolvedRule[] = [];
  const without: string[] = [];
  for (const s of embedded.skills) {
    const f = find(s.ref, 'skill');
    if (f === undefined) continue;
    skills.push(resolved(f, 'domain'));
    if (!s.described) without.push(f.name);
  }
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    text: renderRulesPrompt({ rules, skills, skillsWithoutDescription: without }),
    skills: skills.map((s) => ({ name: s.name, version: s.version, sha256: s.sha256, content: s.content })),
  };
}
