// SPDX-License-Identifier: AGPL-3.0-only
// Porte binaire 0.6b (ADR 0001, 07 §3) : le moteur retenu (Stagehand 3.7.3) pilote Chromium par son propre client CDP,
// il ne tient donc pas en tunnel. Il est refusé avant tout run, aucune commande n'atteint le transport : E6 est limité
// au serveur. Aucun navigateur, aucun LLM.
import { ThirdPartyEngineNotViaTunnelError, assertTunnelEngine, runAgentInTunnel, type AgentStepTransport } from '@runtime/agent';
import type { AgentStepWireArgs, AgentTask } from '@runtime/core';
import { describe, expect, it } from 'vitest';
import { StagehandEngine } from './stagehand-engine.ts';

const engine = new StagehandEngine({ cdpUrl: 'http://127.0.0.1:1', baseURL: 'http://127.0.0.1:1/v1', apiKey: () => 'zz_test_key', price: undefined, startUrl: 'http://zz_test.localhost/' });

describe('assert_third_party_engine_not_via_tunnel : le moteur retenu (Stagehand)', () => {
  it('ne déclare pas agent_step et est refusé en tunnel avant tout run', async () => {
    expect(engine.capabilities.agentStepCompatible).toBe(false);
    expect(() => assertTunnelEngine(engine)).toThrow(ThirdPartyEngineNotViaTunnelError);
    const sent: AgentStepWireArgs[] = [];
    const transport: AgentStepTransport = { send: async (args) => void sent.push(args) };
    const task: AgentTask = {
      taskId: 'zz_test_task', instruction: 'x', startUrl: 'http://zz_test.localhost/', allowedDomains: ['zz_test.localhost'], outputSchema: { type: 'object' },
      allowWriteActions: false, limits: { maxSteps: 1, maxDurationMs: 1000, maxCostUsd: 0.01 },
    };
    await expect(runAgentInTunnel(engine, task, { transport, model: { modelId: 'zz_test', temperature: 0, promptVersion: 'v' } })).rejects.toMatchObject({
      code: 'third_party_engine_not_via_tunnel',
      engineId: 'stagehand',
    });
    expect(sent).toEqual([]);
  });
});
