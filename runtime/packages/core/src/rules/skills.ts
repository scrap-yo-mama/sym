// SPDX-License-Identifier: AGPL-3.0-only
// Chargement progressif des skills (tâche 2.10, 18 §4.4, §4.5) : le prompt ne reçoit que la liste (nom, description) ; le
// corps n'est lu que par l'outil `read_skill(name)`, exécuté par NOTRE processus. Il ne sert qu'un skill de l'ensemble
// résolu (sinon `skill_not_found`), tronqué au plafond de taille, et garde la trace de chaque lecture (empreinte, jamais le
// contenu dans le journal) : un skill lu entre dans la source de la version. Au rejeu d'un E4-E6, seuls les skills
// ÉPINGLÉS dans la source de la version sont servis, à leur version, après vérification de leur `sha256`.
import { RULE_MAX_CHARS, ruleSha256 } from './format.js';
import { ruleRef } from './resolve.js';

export type SkillFile = { readonly name: string; readonly version: number; readonly sha256: string; readonly content: string };
export type SkillRead = { readonly name: string; readonly version: number; readonly sha256: string; readonly ref: string };
export type SkillReadResult = ({ readonly ok: true; readonly content: string } & SkillRead) | { readonly ok: false; readonly code: 'skill_not_found' };

/** Définition de l'outil `read_skill` (format des outils de fonction). */
export const READ_SKILL_TOOL = Object.freeze({
  name: 'read_skill',
  description: 'Read the full text of one skill listed in <skills>, by its name. Only listed skills can be read.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['name'],
    properties: { name: { type: 'string', maxLength: 64 } },
  },
});

export class SkillReader {
  readonly #skills: Map<string, SkillFile>;
  readonly #verify: boolean;
  readonly reads: SkillRead[] = [];

  constructor(skills: readonly SkillFile[], options: { readonly verifySha256?: boolean } = {}) {
    this.#skills = new Map(skills.map((s) => [s.name, s]));
    this.#verify = options.verifySha256 === true;
  }

  /** Noms servis. */
  get names(): string[] {
    return [...this.#skills.keys()];
  }

  read(name: unknown): SkillReadResult {
    const skill = typeof name === 'string' ? this.#skills.get(name) : undefined;
    if (skill === undefined) return { ok: false, code: 'skill_not_found' };
    // Contenu épinglé altéré (base modifiée à la main) : jamais servi.
    if (this.#verify && ruleSha256(skill.content) !== skill.sha256) return { ok: false, code: 'skill_not_found' };
    const read: SkillRead = { name: skill.name, version: skill.version, sha256: skill.sha256, ref: ruleRef(skill) };
    if (!this.reads.some((r) => r.ref === read.ref)) this.reads.push(read);
    return { ok: true, content: skill.content.slice(0, RULE_MAX_CHARS), ...read };
  }
}

/** Lecteur du rejeu : skills épinglés dans la source de la version, empreinte vérifiée. */
export function pinnedSkillReader(pinned: readonly SkillFile[]): SkillReader {
  return new SkillReader(pinned, { verifySha256: true });
}
