// SPDX-License-Identifier: AGPL-3.0-only
// Les quatre jalons d'une enquête (20 § 5.3, 20b § 3.3, u3 R6) : Décrire, Reconnaître, Valider le schéma, Essayer. La
// définition commune (clés, correspondance avec `investigation_phase`, libellés par langue pour le récit MCP et les journaux)
// est `packages/core/src/investigation/milestones.ts` ; la console ne dépend pas de `@runtime/core` (son build reste
// indépendant du serveur, `assert_console_build_independent_of_server`) : ce fichier en est la copie de lecture, et le test
// `assert_milestones_same_labels` (tests/milestones.unit.test.ts) la compare à la source (clés, phases, états, libellés des
// catalogues `investigation.milestones.*`). Fonctions pures, sans I/O.

/** Clés des jalons, dans l'ordre de l'enquête. */
export const INVESTIGATION_MILESTONES = ['describe', 'reconnaissance', 'schema', 'trials'] as const;
export type InvestigationMilestone = (typeof INVESTIGATION_MILESTONES)[number];

/** Sous-états du serveur (`investigation_phase`, 04b § 1). */
export type MilestonePhase = 'access_check' | 'reconnaissance' | 'awaiting_schema_validation' | 'testing' | 'done';

/** Jalon courant de chaque sous-état : le rapport d'accès (étape 0) fait partie de « Reconnaître ». */
export const MILESTONE_OF_PHASE: Readonly<Record<Exclude<MilestonePhase, 'done'>, InvestigationMilestone>> = Object.freeze({
  access_check: 'reconnaissance',
  reconnaissance: 'reconnaissance',
  awaiting_schema_validation: 'schema',
  testing: 'trials',
});

/** État d'un jalon : en texte dans la frise, jamais par la couleur seule. `stopped` : arrêt volontaire ou enquête arrêtée. */
export type MilestoneState = 'todo' | 'current' | 'done' | 'stopped';

/**
 * États des quatre jalons. `phase` : dernier sous-état connu (nul avant le démarrage : jalon 1 en cours, ou fait si l'API est
 * créée). `outcome` : `running` (défaut), `completed` (les quatre sont faits) ou `stopped` (le jalon où l'enquête s'est arrêtée
 * est « arrêté », jamais « fait », et les suivants restent à faire).
 */
export function milestoneStates(input: { phase: MilestonePhase | null; created: boolean; outcome?: 'running' | 'completed' | 'stopped' }): Record<InvestigationMilestone, MilestoneState> {
  const { phase, created, outcome = 'running' } = input;
  const count = INVESTIGATION_MILESTONES.length;
  let at: number;
  if (outcome === 'completed' || phase === 'done') at = count;
  else if (phase === null) at = created ? 1 : 0;
  else at = INVESTIGATION_MILESTONES.indexOf(MILESTONE_OF_PHASE[phase]);
  const out = {} as Record<InvestigationMilestone, MilestoneState>;
  for (const [index, key] of INVESTIGATION_MILESTONES.entries()) {
    if (index < at) out[key] = 'done';
    else if (index === at) out[key] = outcome === 'stopped' ? 'stopped' : 'current';
    else out[key] = 'todo';
  }
  return out;
}
