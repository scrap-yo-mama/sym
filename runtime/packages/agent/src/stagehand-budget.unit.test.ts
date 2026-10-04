// SPDX-License-Identifier: AGPL-3.0-only
// Plafond de coût d'un run de moteur E6 (04b « Schéma et coût », constat UX-32 de la recette du 2026-10-04) : l'essai
// `agent` de l'équipe Janssens a été facturé 0,513 $ puis 0,534 $ pour `max_cost_usd` 0,50 $. Le middleware ne comparait
// que la dépense passée au plafond : l'appel qui le franchissait partait. Il compte désormais le coût prévu de l'appel
// (entrée estimée sur la requête envoyée, sortie du dernier appel). Stagehand est remplacé par un double qui rejoue une
// boucle d'agent à prompt croissant à travers le VRAI middleware : aucun navigateur, aucun réseau.
import { describe, expect, it, vi } from 'vitest';

type Middleware = {
  transformParams: (a: { params: Record<string, unknown> }) => Promise<Record<string, unknown>>;
  wrapGenerate: (a: { doGenerate: () => Promise<unknown>; params: Record<string, unknown>; model: { doGenerate: (p: unknown) => Promise<unknown> } }) => Promise<unknown>;
};
const loop = { sent: 0 };

vi.mock('@browserbasehq/stagehand', () => ({
  Stagehand: class {
    readonly #middleware: Middleware;
    readonly context = { pages: () => [{ goto: async () => undefined }], newPage: async () => ({ goto: async () => undefined }) };
    constructor(options: { model: { middleware: Middleware } }) {
      this.#middleware = options.model.middleware;
    }
    async init(): Promise<void> {}
    async close(): Promise<void> {}
    agent() {
      const mw = this.#middleware;
      return {
        // Boucle d'agent : le prompt grandit de 4 000 caractères (1 000 jetons) par tour ; chaque réponse coûte son entrée
        // et 100 jetons de sortie. S'arrête à la première garde qui refuse l'envoi.
        execute: async () => {
          for (let i = 1; i <= 20; i += 1) {
            const params = await mw.transformParams({ params: { prompt: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(4_000 * i) }] }], tools: [] } });
            const response = { content: [{ type: 'text', text: 'ok' }], usage: { inputTokens: 1_000 * i, outputTokens: 100 }, response: { body: { usage: { prompt_tokens: 1_000 * i, completion_tokens: 100 } } } };
            await mw.wrapGenerate({ doGenerate: async () => response, params, model: { doGenerate: async () => response } });
            loop.sent += 1;
          }
          return { actions: [], completed: true, output: { title: 'zz' } };
        },
      };
    }
  },
}));

const { StagehandEngine } = await import('./stagehand-engine.js');

const task = (maxCostUsd: number) => ({
  taskId: 'zz-budget',
  instruction: 'Lister les membres',
  startUrl: 'http://zz-test.example/',
  allowedDomains: ['zz-test.example'],
  outputSchema: { type: 'object', properties: { title: { type: 'string' } } },
  allowWriteActions: false,
  limits: { maxSteps: 20, maxDurationMs: 5_000, maxCostUsd },
});

describe('assert_run_cost_capped — E6 : l’appel qui franchirait max_cost_usd n’est jamais envoyé (UX-32)', () => {
  it('prompt croissant, prix d’un modèle Opus : arrêt AVANT le dépassement, coût imputé ≤ plafond', async () => {
    loop.sent = 0;
    // 5 $ / 25 $ par million de jetons : tours à 0,0075 $, 0,0125 $, 0,0175 $… ; cumul 0,0875 $ après 5 tours, 0,12 $ après 6.
    const engine = new StagehandEngine({ cdpUrl: 'ws://127.0.0.1:9/zz', baseURL: 'http://127.0.0.1:9/v1', apiKey: () => 'zz-key', price: { in: 5, out: 25 }, env: {} });
    const out = await engine.run(task(0.1), { model: { modelId: 'zz-agent', temperature: 0, promptVersion: 'zz' } });
    expect(out.status).toBe('budget_exceeded');
    expect(out.failureClass).toBe('run_budget_exceeded');
    expect(out.costUsd).not.toBeNull();
    expect(out.costUsd!).toBeLessThanOrEqual(0.1);
    expect(loop.sent).toBe(5);
  });
});
