// SPDX-License-Identifier: AGPL-3.0-only
// Les quatre jalons d'une enquête (20 § 5.3, 20b § 3.3, u3 R6) : Décrire, Reconnaître, Valider le schéma, Essayer. Une seule
// définition, de clés fermées et de libellés par langue, pour la frise de la console, le récit MCP (« 1/4 Décrire … ») et les
// journaux : `assert_milestones_same_labels` (I1). La console garde ses libellés dans ses catalogues (`investigation.milestones.*`)
// et un test les compare à ce fichier ; le récit MCP (3.19) le lira ; le worker écrit chaque jalon atteint dans `run_logs` par `milestoneLogEntry`. « Décrire » n'est pas un
// sous-état serveur : il précède l'enquête (`investigation_phase` nul) et se termine quand `create_api` a rendu l'`api_id`.
// Aucun libellé n'est un texte généré (les phrases de voix sont celles de la tâche 3.19). Les libellés sont ceux du catalogue
// commun (`investigation.milestones.*` de packages/i18n, 3.20) : une langue ajoutée au registre n'exige aucun code (21b M14).
import { defaultI18n } from '@runtime/i18n';

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

/** Code de langue du registre (`@runtime/i18n`) ; une langue inconnue retombe sur `en` (repli du rendu). */
export type MilestoneLocale = string;

/** Libellé d'un jalon dans une langue, lu dans le catalogue commun : le même que la frise de la console. */
export function milestoneLabel(key: InvestigationMilestone, locale: MilestoneLocale): string {
  return defaultI18n().renderer.render(`investigation.milestones.${key}`, {}, locale);
}

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
  return `${INVESTIGATION_MILESTONES.indexOf(key) + 1}/${INVESTIGATION_MILESTONES.length} ${milestoneLabel(key, locale)}`;
}

/**
 * Entrée de journal d'un jalon atteint (`run_logs`, événement `milestone`) : clé et intitulé de récit en anglais. Les journaux
 * portent des codes, en anglais, jamais un texte d'une autre langue du catalogue (21 § 4.7, 21b M10).
 */
export type MilestoneLogEntry = { milestone: InvestigationMilestone; heading: string };

/**
 * Ce que le worker écrit dans les journaux quand une enquête atteint un jalon : la même clé, le même intitulé (« 2/4 Explore »,
 * en anglais : langue des journaux) et les mêmes libellés que la frise de la console et le récit MCP.
 */
export function milestoneLogEntry(key: InvestigationMilestone): MilestoneLogEntry {
  return { milestone: key, heading: milestoneHeading(key, 'en') };
}
