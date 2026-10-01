// Bras B (Stagehand 3.7.3) sur le faux fournisseur : température transmise par middleware (§15), aucune requête vers
// Browserbase ni ailleurs hors boucle locale (§13), aucun patchright installé (INV6). Aucun LLM réel.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentReference, agentTasks } from '../../../fixtures/src/agent-tasks.ts';
import { startFixtureServer, type FixtureServer } from '../../../fixtures/src/server.ts';
import { launchSpikeBrowser } from './browser.ts';
import { forbiddenEnvPresent, startNetMonitor } from './guards.ts';
import { jsonSchemaToZod, StagehandEngine } from './stagehand-engine.ts';

const hasChromium = existsSync(chromium.executablePath());
const runtimeDir = new URL('../../../', import.meta.url).pathname;
const MODEL = 'zai-org/GLM-5.3';

describe('Stagehand 3.7.3 : installation (INV6, licences)', () => {
  it('patchright-core n\'est pas installé (pnpm why vide)', () => {
    const out = execFileSync('pnpm', ['why', 'patchright-core', '-r'], { cwd: runtimeDir, encoding: 'utf8' });
    expect(out.trim()).toBe('');
  });
  it('version épinglée exacte, dans le seul paquet d\'évaluation', () => {
    const pkg = JSON.parse(readFileSync(join(runtimeDir, 'eval/spike/package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(pkg.dependencies['@browserbasehq/stagehand']).toBe('3.7.3');
    for (const dir of ['packages', 'apps']) {
      for (const name of readdirSync(join(runtimeDir, dir))) {
        const file = join(runtimeDir, dir, name, 'package.json');
        if (existsSync(file)) expect(readFileSync(file, 'utf8'), file).not.toContain('browserbasehq');
      }
    }
  });
});

describe('jsonSchemaToZod', () => {
  it('convertit les schémas des fixtures ; la référence passe, un champ en trop non', () => {
    for (const task of agentTasks()) {
      const schema = jsonSchemaToZod(task.outputSchema);
      expect(schema.safeParse(agentReference(task.key)).success, task.key).toBe(true);
    }
    const e4 = jsonSchemaToZod(agentTasks()[0]?.outputSchema ?? {});
    expect(e4.safeParse({ items: [{ id: 'a', title: 't', price_eur: 1, category: null, extra: 1 }] }).success).toBe(false);
    expect(e4.safeParse({ items: [{ id: 'a', title: 't', price_eur: 1, category: 'x' }] }).success).toBe(true);
  });
});

let fx: FixtureServer;
let fake: FakeProvider;

describe.skipIf(!hasChromium)('Stagehand 3.7.3 en local sur le faux fournisseur', () => {
  beforeAll(async () => {
    fx = await startFixtureServer({ port: 0 });
    fake = await createFakeProvider();
  });
  afterAll(async () => {
    await fake?.close();
    await fx?.close();
  });

  it('température 0 envoyée à chaque appel (middleware), zéro requête hors boucle locale, sortie rendue', async () => {
    expect(forbiddenEnvPresent()).toEqual([]);
    const task = agentTasks().find((t) => t.key === 'F-E4');
    if (task === undefined) throw new Error('F-E4 absente');
    fake.setScenario(MODEL, [
      scripted.text('The task is complete.'),
      scripted.toolCalls([{ name: 'done', arguments: { reasoning: 'zz_test', taskComplete: true, output: agentReference('F-E4') } }]),
    ]);
    const net = startNetMonitor([]);
    const browser = await launchSpikeBrowser({ allowedHosts: task.allowedHosts, allowWriteActions: false });
    try {
      const engine = new StagehandEngine({
        cdpUrl: browser.cdpUrl,
        baseURL: fake.baseUrl,
        apiKey: () => 'zz_test_fake_key',
        price: { in: 1, out: 2 },
        startUrl: `http://${task.host}:${fx.port}/`,
      });
      expect(engine.capabilities.agentStepCompatible).toBe(false);
      const result = await engine.run(
        {
          taskId: 'zz_test', instruction: task.instruction, startUrl: '', allowedDomains: task.allowedHosts, outputSchema: task.outputSchema,
          allowWriteActions: false, limits: { maxSteps: 25, maxDurationMs: 60_000, maxCostUsd: 0.5 },
        },
        { model: { modelId: MODEL, temperature: 0, promptVersion: 'v' } },
      );
      expect(result.status).toBe('done');
      expect(result.output).toEqual(agentReference('F-E4'));
      expect(result.costUsd).toBeGreaterThan(0);
      expect(fake.calls.length).toBe(2);
      for (const call of fake.calls) {
        expect(call.body['temperature']).toBe(0);
        expect(call.path).toMatch(/\/chat\/completions$/);
      }
      // Outil de recherche exclu (§13) : ni Browserbase ni Brave.
      const tools = ((fake.calls[0]?.body['tools'] ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
      expect(tools).not.toContain('search');
      expect(net.offsite()).toEqual([]);
      expect(net.events.some((e) => /browserbase|brave/i.test(e.host))).toBe(false);
      expect(browser.requests.every((r) => r.host === task.host)).toBe(true);
    } finally {
      net.stop();
      await browser.close();
    }
  }, 120_000);

  it('un moteur tiers refuse le canal agent_step (07 §3)', async () => {
    const engine = new StagehandEngine({ cdpUrl: 'ws://127.0.0.1:1/x', baseURL: fake.baseUrl, apiKey: () => 'k', price: undefined, startUrl: 'about:blank' });
    const channel = { snapshot: async () => ({ snapshotId: 's', url: '', accessibilityTree: '', truncated: false }), execute: async () => ({ ok: false as const, error: 'timeout' as const }) };
    await expect(
      engine.run(
        { taskId: 'x', instruction: 'x', startUrl: '', allowedDomains: [], outputSchema: {}, allowWriteActions: false, limits: { maxSteps: 1, maxDurationMs: 1000, maxCostUsd: 0.1 } },
        { channel, model: { modelId: MODEL, temperature: 0, promptVersion: 'v' } },
      ),
    ).rejects.toThrow(/agent_step/);
  });
});
