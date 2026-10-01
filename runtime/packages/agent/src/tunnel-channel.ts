// SPDX-License-Identifier: AGPL-3.0-only
// Client `agent_step` du tunnel (07 §3, tâche 0.6b) : le seul code côté serveur qui parle à l'extension pour un agent.
// Il implémente `AgentStepChannel` au-dessus d'un transport abstrait (la passerelle WSS de la tâche 2.7 en fournit un) :
// chaque action devient une commande du jeu fermé, chaque réponse est validée avant d'être crue. Les moteurs tiers
// (Stagehand, ADR 0001) pilotent Chromium par leur propre client CDP : ils ne passent jamais par ici, donc jamais par le
// tunnel. Conséquence écrite dans runtime/docs/agent-step-tunnel.md : E6 par le tunnel n'est pas servi par le moteur
// retenu ; E6 est limité au serveur.
import {
  agentStepToWire,
  parseAgentStepWireResult,
  semanticOf,
  type AgentEngine,
  type AgentEngineId,
  type AgentModelSettings,
  type AgentRunResult,
  type AgentSnapshot,
  type AgentStepAction,
  type AgentStepChannel,
  type AgentStepResult,
  type AgentStepWireArgs,
  type AgentTask,
} from '@runtime/core';

/** Transport d'une commande `agent_step` vers l'extension de l'utilisateur ; rend le corps de réponse (non validé). */
export interface AgentStepTransport {
  send(args: AgentStepWireArgs, options?: { readonly signal?: AbortSignal }): Promise<unknown>;
}

/** Réponse de l'extension hors contrat : jamais comptée comme un succès. */
export class AgentStepProtocolError extends Error {
  readonly code = 'agent_step_protocol_violation' as const;
  readonly action: AgentStepAction['kind'];
  constructor(action: AgentStepAction['kind']) {
    super(`réponse agent_step hors contrat pour l'action « ${action} »`);
    this.name = 'AgentStepProtocolError';
    this.action = action;
  }
}

/** Un moteur qui n'est pas compatible `agent_step` ne traverse pas le tunnel (07 §3, `assert_third_party_engine_not_via_tunnel`). */
export class ThirdPartyEngineNotViaTunnelError extends Error {
  readonly code = 'third_party_engine_not_via_tunnel' as const;
  readonly engineId: AgentEngineId;
  constructor(engineId: AgentEngineId) {
    super(`le moteur « ${engineId} » ne passe pas par le canal agent_step : refusé en tunnel (07 §3)`);
    this.name = 'ThirdPartyEngineNotViaTunnelError';
    this.engineId = engineId;
  }
}

export function assertTunnelEngine(engine: Pick<AgentEngine, 'id' | 'capabilities'>): void {
  if (!engine.capabilities.agentStepCompatible) throw new ThirdPartyEngineNotViaTunnelError(engine.id);
}

const TREES_KEPT = 8;

export class TunnelStepChannel implements AgentStepChannel {
  readonly #transport: AgentStepTransport;
  readonly #signal: AbortSignal | undefined;
  /** Arbres des derniers instantanés reçus : le moteur nomme la cible d'un clic après l'avoir exécuté, la page a alors changé. */
  readonly #trees = new Map<string, string>();
  #challenged = false;

  constructor(transport: AgentStepTransport, options: { readonly signal?: AbortSignal } = {}) {
    this.#transport = transport;
    this.#signal = options.signal;
  }

  /** Rôle et nom accessibles d'un `ref` d'un instantané récent (trace sémantique, compilation E6 → E5). */
  semanticTarget(snapshotId: string, ref: string): { role: string; name: string } | undefined {
    const tree = this.#trees.get(snapshotId);
    return tree === undefined ? undefined : semanticOf(tree, ref);
  }

  #remember(snapshot: AgentSnapshot): void {
    this.#trees.delete(snapshot.snapshotId);
    this.#trees.set(snapshot.snapshotId, snapshot.accessibilityTree);
    for (const id of this.#trees.keys()) {
      if (this.#trees.size <= TREES_KEPT) break;
      this.#trees.delete(id);
    }
  }

  async snapshot(): Promise<AgentSnapshot> {
    const result = await this.execute({ kind: 'read' });
    if (!result.ok) throw new AgentStepProtocolError('read');
    return result.snapshot;
  }

  async execute(action: AgentStepAction): Promise<AgentStepResult> {
    // Un défi a arrêté le run : l'extension n'envoie plus rien sur cet onglet et nous non plus (07 §5).
    if (this.#challenged) return { ok: false, error: 'challenge_detected' };
    const raw = await this.#transport.send(agentStepToWire(action), this.#signal === undefined ? {} : { signal: this.#signal });
    const result = parseAgentStepWireResult(raw);
    if (result === null) throw new AgentStepProtocolError(action.kind);
    if (result.snapshot !== undefined) this.#remember(result.snapshot);
    if (!result.ok && result.error === 'challenge_detected') this.#challenged = true;
    return result;
  }
}

export interface AgentTunnelRunOptions {
  readonly transport: AgentStepTransport;
  readonly model: AgentModelSettings;
  readonly signal?: AbortSignal;
}

/** Lance un moteur sur le tunnel : refuse d'abord tout moteur tiers, puis lui donne le seul canal `agent_step`. */
export async function runAgentInTunnel(engine: AgentEngine, task: AgentTask, options: AgentTunnelRunOptions): Promise<AgentRunResult> {
  assertTunnelEngine(engine);
  const channel = new TunnelStepChannel(options.transport, options.signal === undefined ? {} : { signal: options.signal });
  return engine.run(task, options.signal === undefined ? { channel, model: options.model } : { channel, model: options.model, signal: options.signal });
}
