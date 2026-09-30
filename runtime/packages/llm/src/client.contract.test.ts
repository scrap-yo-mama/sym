// SPDX-License-Identifier: AGPL-3.0-only
// Contrat du client LLM (08 §1 « Tests de contrat », 15 §4) : P0 = DeepInfra zai-org/GLM-5.3 et OpenRouter, en réponses
// ENREGISTRÉES (cassettes msw, replay strict). Les cas qu'on ne peut pas obtenir réellement (5xx, refus, 429, vide) sont
// des cassettes écrites à la main, marquées `synthetic: true`. Réenregistrement : LLM_CASSETTE_MODE=record (voir CONTRIBUTING).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Secret } from '@runtime/core';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createLlmClient, type LlmClient, type ProviderConfig } from './client.js';
import { createCassetteKit, providerFixture, secretValuesFromEnv, type ProviderFixture } from './cassette.testkit.js';
import type { CapabilityProfile } from './profile.js';
import { probeCapabilities } from './profile.js';
import { OpenAICompatTransport } from './transport.js';
import type { ChatMessage, ToolDef } from './types.js';

const CASSETTES = join(import.meta.dirname, '..', 'cassettes');
const kit = createCassetteKit(CASSETTES);
// Enregistrement : appels réels de modèles à raisonnement, donc lents ; rejeu : quasi instantané.
vi.setConfig({ testTimeout: kit.mode === 'record' ? 180_000 : 10_000 });
beforeAll(() => kit.start());
afterAll(() => kit.stop());
afterEach(() => kit.finish());

const AGENT_PROFILE: CapabilityProfile = {
  model: 'p0',
  tools: true,
  tool_choice: ['auto', 'named'],
  structured_modes: ['json_schema', 'tool_forced', 'json_object'],
  structured: 'json_schema',
  stream_tools: null,
  stream_usage: null,
  cache: false,
  reasoning_field: null,
  probed_at: '2026-10-01T00:00:00Z',
  probe_tokens: 0,
  notes: [],
};

// Prix de TEST (USD / million) : sert à vérifier l'arithmétique, pas à chiffrer le modèle réel.
const TEST_PRICE = { in: 1, in_cached: 0.2, out: 4 };

const WEATHER: ToolDef = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
  },
};

function build(p: ProviderFixture, opts: { fallback?: ProviderFixture } = {}): { client: LlmClient; sleeps: number[] } {
  const sleeps: number[] = [];
  const mk = (f: ProviderFixture): ProviderConfig => ({
    id: f.id,
    baseUrl: f.baseUrl,
    apiKey: f.apiKey,
    ...(f.extraBody ? { extraBody: f.extraBody } : {}),
    models: [{ id: f.model, profile: AGENT_PROFILE, price: TEST_PRICE }],
  });
  const providers = [mk(p), ...(opts.fallback ? [mk(opts.fallback)] : [])];
  const client = createLlmClient(
    {
      providers,
      roles: {
        agent: { provider: p.id, model: p.model, ...(opts.fallback ? { fallback: { provider: opts.fallback.id, model: opts.fallback.model } } : {}) },
      },
    },
    { sleep: async (ms) => void sleeps.push(ms), random: () => 1 },
  );
  return { client, sleeps };
}

const user = (content: string): ChatMessage[] => [{ role: 'user', content }];
const SYNTHETIC = { synthetic: true } as const;

describe.each(['deepinfra', 'openrouter'] as const)('assert_llm_contract : %s', (id) => {
  const p = providerFixture(id);
  const other = providerFixture(id === 'deepinfra' ? 'openrouter' : 'deepinfra');

  test('succès : appel d\'outils en 2 étapes, usage et coût', async () => {
    kit.use(id, 'tools-2-steps');
    const { client } = build(p);
    const first = await client.chat('agent', { messages: user('What is the weather in Paris? Use the tool.'), tools: [WEATHER], toolChoice: 'auto', maxTokens: 700 });
    const call = first.result.message.tool_calls?.[0];
    expect(call?.function.name).toBe('get_weather');
    expect(JSON.parse(call?.function.arguments ?? '{}')).toHaveProperty('city');
    expect(first.result.finish_reason).toBe('tool_calls');

    const second = await client.chat('agent', {
      messages: [...user('What is the weather in Paris? Use the tool.'), first.result.message, { role: 'tool', tool_call_id: call?.id ?? '', content: '{"temp_c":18,"sky":"cloudy"}' }],
      tools: [WEATHER],
      maxTokens: 700,
    });
    expect(typeof second.result.message.content).toBe('string');
    expect((second.result.message.content as string).length).toBeGreaterThan(0);

    const usage = client.usage();
    expect(usage.calls).toBe(2);
    expect(usage.tokens_in).toBeGreaterThan(0);
    expect(usage.tokens_out).toBeGreaterThan(0);
    expect(usage.tokens_reasoning).toBeGreaterThanOrEqual(0);
    expect(usage.usage_estimated).toBe(false);
    expect(usage.cost_usd).toBeGreaterThan(0);
    expect(first.usage.cost_source).toBe(id === 'openrouter' ? 'provider' : 'price');
  });

  test('schéma strict : S1, Ajv final sur le schéma d\'origine', async () => {
    kit.use(id, 'schema-strict');
    const { client } = build(p);
    const schema = {
      type: 'object',
      properties: { city: { type: 'string', minLength: 2 }, population_millions: { type: 'number', minimum: 0 }, nickname: { type: 'string' } },
      required: ['city', 'population_millions'],
    };
    const out = await client.generateStructured<{ city: string; population_millions: number }>('agent', {
      messages: user('Give the city Paris with its population in millions (about 2.1). No nickname.'),
      schema,
      name: 'city',
      level: 'S1',
      maxTokens: 900,
    });
    expect(out.level).toBe('S1');
    expect(out.value.city.length).toBeGreaterThanOrEqual(2);
    expect(out.value.population_millions).toBeGreaterThan(0);
    expect(out.repairs).toBeLessThanOrEqual(2);
  });

  test('flux à 2 appels : agrégation, outil rendu à finish_reason tool_calls', async () => {
    kit.use(id, 'stream-2-calls');
    const { client } = build(p);
    const first = await client.call('agent', { messages: user('What is the weather in Lyon? Use the tool.'), tools: [WEATHER], stream: true, max_tokens: 700 });
    expect(first.result.streamed).toBe(true);
    const call = first.result.message.tool_calls?.[0];
    expect(call?.function.name).toBe('get_weather');
    expect(JSON.parse(call?.function.arguments ?? '{}')).toHaveProperty('city');
    const second = await client.call('agent', {
      messages: [...user('What is the weather in Lyon? Use the tool.'), first.result.message, { role: 'tool', tool_call_id: call?.id ?? '', content: '{"temp_c":15}' }],
      tools: [WEATHER],
      stream: true,
      max_tokens: 700,
    });
    expect(second.result.streamed).toBe(true);
    expect((second.result.message.content as string).length).toBeGreaterThan(0);
    expect(client.usage().tokens_in).toBeGreaterThan(0);
  });

  test('réponse tronquée : truncated, sans réessai, usage facturé imputé', async () => {
    kit.use(id, 'truncated');
    const { client, sleeps } = build(p);
    const err = await client.chat('agent', { messages: user('Write a long poem about the sea, at least 40 lines.'), maxTokens: 12 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ class: 'truncated', failureClass: 'llm_truncated' });
    expect(sleeps).toEqual([]);
    expect(client.usage().tokens_out).toBeGreaterThan(0);
  });

  test('erreur non réessayable : clé refusée => auth, 1 seule requête, aucun repli', async () => {
    kit.use(id, 'auth-401');
    const bad: ProviderFixture = { ...p, apiKey: new Secret('invalid-key-zz-not-real') };
    const { client, sleeps } = build(bad, { fallback: other });
    await expect(client.chat('agent', { messages: user('hi'), maxTokens: 5 })).rejects.toMatchObject({ class: 'auth' });
    expect(sleeps).toEqual([]);
  });

  test('profil de capacités : sonde de 3 appels minuscules', async () => {
    kit.use(id, 'probe');
    const transport = new OpenAICompatTransport({ baseUrl: p.baseUrl, apiKey: p.apiKey, ...(p.extraBody ? { extraBody: p.extraBody } : {}) });
    const profile = await probeCapabilities(transport, p.model, () => new Date('2026-10-01T00:00:00Z'));
    expect(profile.tools).toBe(true);
    expect(profile.tool_choice).toContain('auto');
    expect(profile.structured).not.toBe('none');
    expect(profile.probe_tokens).toBeGreaterThan(0);
    expect(profile.probe_tokens).toBeLessThan(2500); // 3 appels minuscules ; un nouvel essai au plus par appel tronqué par le raisonnement
    expect(profile.probed_at).toBe('2026-10-01T00:00:00.000Z');
  });

  // Cas synthétiques : écrits à la main, jamais réenregistrés.
  test('[synthétique] 429 avec Retry-After : attente respectée, puis succès', async () => {
    kit.use(id, 'rate-limited-429', SYNTHETIC);
    const { client, sleeps } = build(p);
    const out = await client.chat('agent', { messages: user('hi') });
    expect(out.result.message.content).toBe('pong');
    expect(sleeps).toEqual([2000]);
    expect(out.attempts.map((a) => a.failure_class)).toEqual(['llm_rate_limited', null]);
  });

  test('[synthétique] 5xx : overloaded après 3 réessais avec backoff', async () => {
    kit.use(id, 'server-5xx', SYNTHETIC);
    const { client, sleeps } = build(p);
    await expect(client.chat('agent', { messages: user('hi') })).rejects.toMatchObject({ class: 'overloaded' });
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  test('[synthétique] contenu vide : empty_response après 2 réessais', async () => {
    kit.use(id, 'empty-response', SYNTHETIC);
    const { client } = build(p);
    await expect(client.chat('agent', { messages: user('hi') })).rejects.toMatchObject({ class: 'empty_response' });
  });

  test('[synthétique] assert_llm_no_fallback : refus => llm_refused, une requête, le fournisseur de repli n\'est jamais appelé', async () => {
    kit.use(id, 'refusal', SYNTHETIC);
    const { client, sleeps } = build(p, { fallback: other });
    const err = await client.chat('agent', { messages: user('hi') }).catch((e: unknown) => e);
    expect(err).toMatchObject({ class: 'llm_refused', failureClass: 'llm_llm_refused' });
    expect(sleeps).toEqual([]);
    // La cassette ne contient qu'une entrée : toute requête vers le repli aurait été inconnue (replay strict) et ferait échouer finish().
  });
});

describe('cassettes : aucun secret (test canari)', () => {
  const listFiles = () => readdirSync(CASSETTES, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json'));
  const files = listFiles();

  test('les cassettes existent : 2 fournisseurs x (6 réels + 4 synthétiques)', () => {
    expect(listFiles()).toHaveLength(2 * 10);
  });

  test.each(files)('%s ne contient ni clé, ni Authorization, ni Bearer', (file) => {
    const text = readFileSync(join(CASSETTES, file), 'utf8');
    expect(text).not.toMatch(/\bsk-[A-Za-z0-9]/);
    expect(text).not.toMatch(/Bearer\s/i);
    expect(text).not.toMatch(/authorization/i);
    expect(text).not.toMatch(/x-api-key|set-cookie/i);
    expect(text).not.toContain('invalid-key-zz-not-real');
    expect(text).not.toContain('replay-placeholder-not-a-key');
    // Pendant un enregistrement seulement : la valeur des clés de l'environnement est absente.
    for (const secret of secretValuesFromEnv()) expect(text.includes(secret)).toBe(false);
  });

  test('les cas synthétiques sont marqués, les autres non', () => {
    for (const file of listFiles()) {
      const data = JSON.parse(readFileSync(join(CASSETTES, file), 'utf8')) as { synthetic: boolean; note?: string };
      const isSynthetic = /(rate-limited-429|server-5xx|empty-response|refusal)\.json$/.test(file);
      expect(data.synthetic).toBe(isSynthetic);
      if (isSynthetic) expect(data.note).toMatch(/synthétique/);
    }
  });
});
