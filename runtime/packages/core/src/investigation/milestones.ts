// SPDX-License-Identifier: AGPL-3.0-only
// Les quatre jalons d'une enquête (20 § 5.3, 20b § 3.3, u3 R6) : Décrire, Reconnaître, Valider le schéma, Essayer. Une seule
// définition, de clés fermées et de libellés par langue, pour la frise de la console, le récit MCP (« 1/4 Décrire … ») et les
// journaux : `assert_milestones_same_labels` (I1). La console garde ses libellés dans ses catalogues (`investigation.milestones.*`)
// et un test les compare à ce fichier ; le récit MCP (3.19) et le rendu des journaux lisent celui-ci. « Décrire » n'est pas un
// sous-état serveur : il précède l'enquête (`investigation_phase` nul) et se termine quand `create_api` a rendu l'`api_id`.
// Fonctions pures, sans I/O ; aucun libellé n'est un texte généré (les phrases de voix sont celles de la tâche 3.19).

/** Clés des jalons, dans l'ordre de l'enquête. */
export const INVESTIGATION_MILESTONES = ['describe', 'reconnaissance', 'schema', 'trials'] as const;
export type InvestigationMilestone = (typeof INVESTIGATION_MILESTONES)[number];

/** Sous-états du serveur (`investigation_phase`, 04b § 1). */
export type MilestonePhase = 'access_check' | 'reconnaissance' | 'awaiting_schema_validation' | 'testing' | 'done';

/**
 * Jalon courant de chaque sous-état : le rapport d'accès (étape 0) fait partie de « Reconnaître » ; `done` n'est plus un
 * jalon courant (les quatre sont faits, ou le dernier est arrêté).
 */
export const MILESTONE_OF_PHASE: Readonly<Record<Exclude<MilestonePhase, 'done'>, InvestigationMilestone>> = Object.freeze({
  access_check: 'reconnaissance',
  reconnaissance: 'reconnaissance',
  awaiting_schema_validation: 'schema',
  testing: 'trials',
});

export type MilestoneLocale = 'en' | 'fr';

/** Libellés des jalons par langue (21 : tutoiement, voix de la console ; transcréation de `en`). */
export const MILESTONE_LABELS: Readonly<Record<MilestoneLocale, Readonly<Record<InvestigationMilestone, string>>>> = Object.freeze({
  en: Object.freeze({ describe: 'Describe', reconnaissance: 'Explore', schema: 'Validate the schema', trials: 'Try' }),
  fr: Object.freeze({ describe: 'Décrire', reconnaissance: 'Reconnaître', schema: 'Valider le schéma', trials: 'Essayer' }),
});

/** État d'un jalon dans la frise : en texte, jamais par la couleur seule. `stopped` : arrêt volontaire ou enquête arrêtée. */
export type MilestoneState = 'todo' | 'current' | 'done' | 'stopped';

/**
 * États des quatre jalons. `phase` : dernier sous-état connu (nul avant le démarrage : jalon 1 en cours, ou fait si l'API
 * est créée). `outcome` : `running` (défaut), `completed` (les quatre sont faits) ou `stopped` (refus, arrêt de
 * l'utilisateur : le jalon où l'enquête s'est arrêtée est « arrêté », jamais « fait », et les suivants restent à faire ;
 * 06 de u3 : « la frise ne propose aucune suite »).
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

/** Ligne de récit d'un jalon : « 1/4 Décrire ». Le résultat (`… {résultat}`) est ajouté par l'appelant (voix de 3.19). */
export function milestoneHeading(key: InvestigationMilestone, locale: MilestoneLocale): string {
  return `${INVESTIGATION_MILESTONES.indexOf(key) + 1}/${INVESTIGATION_MILESTONES.length} ${MILESTONE_LABELS[locale][key]}`;
}
