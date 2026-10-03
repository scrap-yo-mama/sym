// SPDX-License-Identifier: AGPL-3.0-only
// assert_stagehand_no_integrations (tâche 2.10, 18 §4.5, §5) : un run E6 instancie Stagehand avec `systemPrompt` = règles
// résolues et liste des skills, `tools` = { read_skill } exécuté dans notre processus (skills de l'ensemble résolu ou
// épinglés seulement), et `integrations` (clients MCP) toujours vide en V1. Stagehand est remplacé par un double qui
// capture la configuration de `agent()` : aucun navigateur, aucun appel au modèle.
import { afterEach, describe, expect, it, vi } from 'vitest';

const captured: { agentConfig: Record<string, unknown> | null } = { agentConfig: null };

vi.mock('@browserbasehq/stagehand', () => ({
  Stagehand: class {
    readonly context = { pages: () => [{ goto: async () => undefined }], newPage: async () => ({ goto: async () => undefined }) };
    async init(): Promise<void> {}
    async close(): Promise<void> {}
    agent(config: Record<string, unknown>) {
      captured.agentConfig = config;
      return { execute: async () => ({ actions: [], completed: true, output: { title: 'zz' } }) };
    }
  },
}));

const { StagehandEngine, stagehandAgentConfig } = await import('./stagehand-engine.js');
const { toolsOutsideClosedList } = await import('./stagehand-guards.js');

const task = (rules?: { systemPrompt: string; readSkill: (name: string) => Promise<string> }) => ({
  taskId: 'zz-task',
  instruction: 'Lister les titres',
  startUrl: 'http://zz-test.example/',
  allowedDomains: ['zz-test.example'],
  outputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  allowWriteActions: false,
  limits: { maxSteps: 3, maxDurationMs: 5_000, maxCostUsd: 1 },
  ...(rules === undefined ? {} : { rules }),
});

afterEach(() => {
  captured.agentConfig = null;
});

describe('assert_stagehand_no_integrations', () => {
  it('systemPrompt contient les règles résolues, tools contient read_skill, integrations est vide', async () => {
    const reads: string[] = [];
    const rules = {
      systemPrompt: '<trusted_rules>\n## zz-regle@2 (domain)\nFermer le bandeau de consentement d’abord.\n</trusted_rules>\n<skills>\n- zz-skill: Paginer\n</skills>',
      readSkill: async (name: string) => {
        reads.push(name);
        return name === 'zz-skill' ? 'Corps du skill' : 'skill_not_found';
      },
    };
    const engine = new StagehandEngine({ cdpUrl: 'ws://127.0.0.1:9/zz', baseURL: 'http://127.0.0.1:9/v1', apiKey: () => 'zz-key', price: { in: 1, out: 1 }, env: {} });
    await engine.run(task(rules), { model: { modelId: 'zz-agent', temperature: 0, promptVersion: 'zz' } });
    const config = captured.agentConfig!;
    expect(config['mode']).toBe('dom');
    expect(config['systemPrompt']).toContain('zz-regle@2 (domain)');
    expect(Object.keys(config['tools'] as object)).toEqual(['read_skill']);
    expect(config['integrations'] === undefined || (Array.isArray(config['integrations']) && config['integrations'].length === 0)).toBe(true);
    const readSkill = (config['tools'] as { read_skill: { execute: (args: { name: string }) => Promise<unknown> } }).read_skill;
    expect(await readSkill.execute({ name: 'zz-skill' })).toContain('Corps du skill');
    expect(reads).toEqual(['zz-skill']);
  });

  it('sans règles : aucun systemPrompt ajouté, read_skill toujours présent, aucune intégration ; un MCP fourni est refusé', () => {
    const config = stagehandAgentConfig(task());
    expect(config.integrations).toEqual([]);
    expect(Object.keys(config.tools)).toEqual(['read_skill']);
    expect(() => stagehandAgentConfig({ ...task(), integrations: ['https://mcp.zz-test.example'] } as never)).toThrow(/integrations/);
  });

  it('read_skill fait partie de la liste fermée des outils proposés au modèle', () => {
    expect(toolsOutsideClosedList(['act', 'read_skill', 'done'])).toEqual([]);
  });
});
