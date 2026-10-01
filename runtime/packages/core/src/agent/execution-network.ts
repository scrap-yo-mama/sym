// SPDX-License-Identifier: AGPL-3.0-only
// Niveaux d'exécution servis par niveau réseau (07 §3, ADR 0001, tâche 0.6b). Le moteur agentique retenu (Stagehand
// 3.7.3) pilote Chromium par son propre client CDP : il ne passe pas par le canal `agent_step`, donc pas par le tunnel
// (`assert_third_party_engine_not_via_tunnel`). Conséquence : E6 (`agent`) est limité au serveur. L'ordonnancement
// (tâche 2.4) et la passerelle (tâche 2.7) appellent ce garde avant de retenir une stratégie ; le lever exige un nouvel
// ADR (runtime/docs/agent-step-tunnel.md).
import type { Execution, Network } from '../model/enums.js';

/** Niveaux d'exécution qui ne traversent pas le tunnel. */
const SERVER_ONLY: ReadonlySet<Execution> = new Set<Execution>(['agent']);

export function executionAllowedOnNetwork(execution: Execution, network: Network): boolean {
  return network !== 'tunnel' || !SERVER_ONLY.has(execution);
}

/** Stratégie refusée sur ce niveau réseau : E6 en mode tunnel. */
export class ExecutionNotOnNetworkError extends Error {
  readonly code = 'execution_server_only' as const;
  readonly execution: Execution;
  readonly network: Network;
  constructor(execution: Execution, network: Network) {
    super(`l'exécution « ${execution} » est limitée au serveur : refusée en mode « ${network} » (07 §3, ADR 0001)`);
    this.name = 'ExecutionNotOnNetworkError';
    this.execution = execution;
    this.network = network;
  }
}

export function assertExecutionOnNetwork(execution: Execution, network: Network): void {
  if (!executionAllowedOnNetwork(execution, network)) throw new ExecutionNotOnNetworkError(execution, network);
}
