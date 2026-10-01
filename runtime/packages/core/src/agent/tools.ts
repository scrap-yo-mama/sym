// SPDX-License-Identifier: AGPL-3.0-only
// Outils de l'agent en liste FERMÉE (08 §4, mesure 3 ; liste figée par la tâche 1.6) : navigation dans les domaines de
// l'API, clic, saisie, défilement, attente, instantané, extraction, fin. Aucun autre outil : ni shell, ni installation,
// ni mode « tout approuver », ni changement de tâche. Les moteurs E5 et E6 (tâche 2.4) n'exposent que ceux-ci.
export const AGENT_TOOLS = Object.freeze(['navigate', 'click', 'type', 'scroll', 'wait', 'snapshot', 'extract', 'finish'] as const);
export type AgentToolName = (typeof AGENT_TOOLS)[number];

export function isAgentTool(name: unknown): name is AgentToolName {
  return typeof name === 'string' && (AGENT_TOOLS as readonly string[]).includes(name);
}
