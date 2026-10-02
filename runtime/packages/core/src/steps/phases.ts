// SPDX-License-Identifier: AGPL-3.0-only
// Règle des deux par phase, partie « agent » (19 §7, r6 R1, R7, tâche 2.13) : le registre d'outils de chaque phase de
// l'agent est CONSTRUIT PAR LE CODE à partir du tableau de 19 §7 ; jamais A (entrée non fiable), B (données privées) et C
// (sortie) complets à la fois. Aucun pont MCP en V1 (MCP dans l'agent : V1.1), et par construction jamais pendant un run
// avec session, en tunnel ou en agent instruit (`assert_mcp_off_with_session`, `assert_mcp_off_in_instructed_mode`), même
// si l'appelant en demande un. Le registre et la politique de requêtes complets de 2.12 (non fusionnée) reprendront ce
// tableau ; ici, les phases de l'agent livré par 2.4 et de la reprise par étape.

export const AGENT_PHASES = ['replay', 'e4_extract', 'investigation', 'e5_delegated', 'e6', 'step_repair', 'instructed', 'session_or_tunnel', 'judge'] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

/** Jambe complète (`full`), réduite par du code (`reduced`), ou absente (`none`). */
export type Leg = 'full' | 'reduced' | 'none';
export type AgentToolRegistry = {
  readonly phase: AgentPhase;
  /** Outils exposés au modèle, liste fermée. */
  readonly tools: readonly string[];
  readonly mcp: false;
  readonly legs: { readonly A: Leg; readonly B: Leg; readonly C: Leg };
};

/** Outils de l'agent d'étape (19 §4) : `type` saisit une ENTRÉE DU RUN désignée par son nom, jamais un texte libre. */
export const STEP_AGENT_TOOLS = Object.freeze(['click', 'type', 'scroll', 'read_skill', 'done'] as const);
/** Outils du moteur E6 / E5 délégué (liste figée par 1.6, `AGENT_TOOLS`). */
const ENGINE_TOOLS = ['navigate', 'click', 'type', 'scroll', 'wait', 'snapshot', 'extract', 'finish'] as const;

const TABLE: Record<AgentPhase, { tools: readonly string[]; legs: AgentToolRegistry['legs'] }> = {
  // Rejeu E1-E3 compilé : aucun LLM.
  replay: { tools: [], legs: { A: 'none', B: 'none', C: 'reduced' } },
  // E4 : LLM en quarantaine, aucun outil.
  e4_extract: { tools: [], legs: { A: 'full', B: 'none', C: 'none' } },
  investigation: { tools: [], legs: { A: 'full', B: 'reduced', C: 'reduced' } },
  e5_delegated: { tools: ENGINE_TOOLS, legs: { A: 'full', B: 'reduced', C: 'reduced' } },
  e6: { tools: ENGINE_TOOLS, legs: { A: 'full', B: 'reduced', C: 'reduced' } },
  step_repair: { tools: STEP_AGENT_TOOLS, legs: { A: 'full', B: 'reduced', C: 'reduced' } },
  // Agent instruit : à chaque run, mémoire structurelle seulement.
  instructed: { tools: ENGINE_TOOLS, legs: { A: 'full', B: 'reduced', C: 'reduced' } },
  // Avec session ou en tunnel : page connectée (B complet), donc C réduit (domaine cible, écriture interdite par défaut)
  // et reprise au niveau 1 seulement (aucun agent, aucun outil).
  session_or_tunnel: { tools: [], legs: { A: 'full', B: 'full', C: 'reduced' } },
  judge: { tools: [], legs: { A: 'full', B: 'reduced', C: 'none' } },
};

export function agentToolRegistry(phase: AgentPhase, options: { requestMcp?: boolean } = {}): AgentToolRegistry {
  void options.requestMcp; // V1 : aucun pont MCP, demandé ou non (V1.1, et jamais avec session, en tunnel, en instruit).
  const row = TABLE[phase];
  return Object.freeze({ phase, tools: Object.freeze([...row.tools]), mcp: false as const, legs: Object.freeze({ ...row.legs }) });
}

/** Au plus deux des trois jambes complètes. */
export function ruleOfTwoHolds(registry: AgentToolRegistry): boolean {
  const full = [registry.legs.A, registry.legs.B, registry.legs.C].filter((l) => l === 'full').length;
  return full <= 2 && registry.mcp === false;
}
