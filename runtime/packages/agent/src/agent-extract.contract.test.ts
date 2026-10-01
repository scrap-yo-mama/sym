// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.4 : E4 sur un VRAI modèle P0 (DeepInfra zai-org/GLM-5.3), en réponses ENREGISTRÉES (cassettes msw, rejeu
// strict, 15 §4) : la fixture HTML irrégulière (F-E4, 4 gabarits, catégorie parfois absente) est résolue exactement, et la
// fixture d'injection (F-INJ) rend ses 5 produits sans la chaîne canari. Aucun appel réseau en rejeu.
// Réenregistrement : `set -a; . ~/.config/scrapyomama/test.env; set +a; LLM_CASSETTE_MODE=record pnpm vitest run --project
// contract packages/agent/src/agent-extract.contract.test.ts` (clé jamais écrite : la cassette est purgée, test canari).
import { join } from 'node:path';
import { htmlToVisibleText } from '@runtime/core';
import { createLlmClient, type CapabilityProfile } from '@runtime/llm';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createCassetteKit, providerFixture } from '../../llm/src/cassette.testkit.ts';
import { AGENT_CANARY, AGENT_HOSTS } from '../../../fixtures/src/sites/agent-sites.ts';
import { agentReference, agentTasks, type AgentFixtureKey } from '../../../fixtures/src/agent-tasks.ts';
import { startClient } from '../../../fixtures/src/test-helpers.ts';
import { extractRecordsWithLlm } from './agent-extract.js';

const kit = createCassetteKit(join(import.meta.dirname, '..', 'cassettes'));
vi.setConfig({ testTimeout: kit.mode === 'record' ? 300_000 : 10_000 });

/** Profil de GLM-5.3 chez DeepInfra (08 §7) : sortie structurée par `json_object` (S3), Ajv final sur le schéma d'origine. */
const PROFILE: CapabilityProfile = {
  model: 'zai-org/GLM-5.3',
  tools: true,
  tool_choice: ['auto'],
  structured_modes: ['json_object'],
  structured: 'json_object',
  stream_tools: null,
  stream_usage: null,
  cache: true,
  reasoning_field: 'reasoning_content',
  probed_at: '2026-10-01T00:00:00Z',
  probe_tokens: 0,
  notes: [],
};
/** Prix relevé le 2026-10-01 (ADR 0001, annexe) en USD par million de jetons. */
const PRICE = { in: 0.563, in_cached: 0.125, out: 2.5 };

const pages: Partial<Record<AgentFixtureKey, { text: string; url: string }>> = {};

beforeAll(async () => {
  // Pages lues AVANT l'interception msw (serveur de fixtures local, graine par défaut : pages déterministes).
  const client = await startClient();
  try {
    for (const [key, host] of [['F-E4', AGENT_HOSTS.e4], ['F-INJ', AGENT_HOSTS.inj]] as const) {
      const res = await client.get(host, '/');
      pages[key] = { text: htmlToVisibleText(res.body.replaceAll(`:${client.server.port}`, ':4010'), 60_000).text, url: `http://${host}:4010/` };
    }
  } finally {
    await client.close();
  }
  kit.start();
});
afterAll(() => kit.stop());
afterEach(() => kit.finish());

function llm() {
  const p = providerFixture('deepinfra');
  return createLlmClient({
    providers: [{ id: 'deepinfra', baseUrl: p.baseUrl, apiKey: p.apiKey, models: [{ id: p.model, profile: PROFILE, price: PRICE }] }],
    roles: { extract: { provider: 'deepinfra', model: p.model, maxTokens: 8000 } },
  });
}

const item = (key: AgentFixtureKey): unknown => (agentTasks().find((t) => t.key === key)!.outputSchema as { properties: { items: { items: unknown } } }).properties.items.items;
const byId = (rows: readonly unknown[]) => [...rows].sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)));

describe('E4 sur GLM-5.3 (DeepInfra), réponses enregistrées', () => {
  test('assert_e4_irregular_html — F-E4 : 8 produits exacts (prix en nombre, catégorie nulle quand absente)', async () => {
    kit.use('deepinfra', 'e4-irregular-html');
    const client = llm();
    const page = pages['F-E4']!;
    const out = await extractRecordsWithLlm(client, { instruction: agentTasks().find((t) => t.key === 'F-E4')!.instruction, pageText: page.text, pageUrl: page.url, truncated: false, itemSchema: item('F-E4') });
    expect(byId(out.records)).toEqual(byId((agentReference('F-E4') as { items: unknown[] }).items));
    expect(client.usage().cost_usd).toBeGreaterThan(0);
  });

  test('assert_prompt_injection_no_trap_request — F-INJ : 5 produits exacts, aucune chaîne canari, aucun outil offert', async () => {
    kit.use('deepinfra', 'e4-prompt-injection');
    const page = pages['F-INJ']!;
    const out = await extractRecordsWithLlm(llm(), { instruction: agentTasks().find((t) => t.key === 'F-INJ')!.instruction, pageText: page.text, pageUrl: page.url, truncated: false, itemSchema: item('F-INJ') });
    expect(byId(out.records)).toEqual(byId((agentReference('F-INJ') as { items: unknown[] }).items));
    expect(JSON.stringify(out.records)).not.toContain(AGENT_CANARY);
  });
});
