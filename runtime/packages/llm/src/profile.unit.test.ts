import { Secret } from '@runtime/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createFakeProvider, scripted, type FakeProvider } from './fake-provider.js';
import { probeCapabilities, resolveToolChoice, roleProblems, type CapabilityProfile } from './profile.js';
import { OpenAICompatTransport } from './transport.js';

let fake: FakeProvider;
beforeEach(async () => {
  fake = await createFakeProvider();
});
afterEach(() => fake.close());

const transport = () => new OpenAICompatTransport({ baseUrl: fake.baseUrl, apiKey: new Secret('k-0000-0000') });
const ping = (n: number) => scripted.toolCalls([{ name: 'ping', arguments: { n } }], { prompt_tokens: 50, completion_tokens: 10, cached_tokens: 0 });
const probe = () => probeCapabilities(transport(), 'm', () => new Date('2026-10-01T00:00:00Z'));

describe('sonde de capacités', () => {
  test('modèle complet : outils, tool_choice, json_schema, cache', async () => {
    fake.setScenario('m', [ping(1), scripted.json({ n: 2 }), ping(3)]);
    const p = await probe();
    expect(p).toMatchObject({ tools: true, tool_choice: ['auto', 'named'], structured: 'json_schema', cache: true, stream_tools: null, stream_usage: null });
    expect(p.structured_modes).toEqual(['json_schema', 'tool_forced', 'json_object']);
    expect(fake.requests).toBe(3);
    expect(fake.calls.every((c) => c.body['stream'] === false)).toBe(true);
    expect(fake.calls.every((c) => (c.body['max_tokens'] as number) <= 300)).toBe(true);
  });

  test('z.ai : json_schema accepté puis prose (HTTP 200) => pas de json_schema, appel forcé non confirmé', async () => {
    fake.setScenario('m', [ping(1), scripted.text('Voici une description en prose.'), scripted.text('Je préfère répondre en texte.')]);
    const p = await probe();
    expect(p.structured_modes).toEqual(['json_object']);
    expect(p.tool_choice).toEqual(['auto']);
    expect(p.structured).toBe('json_object');
    expect(p.notes.join(' ')).toContain('prose');
  });

  test('modèle sans outils ni response_format (4xx) : profil minimal, structured none', async () => {
    const reject = scripted.error(400, { error: { message: 'unsupported parameter' } });
    fake.setScenario('m', [reject, reject, reject]);
    const p = await probe();
    expect(p).toMatchObject({ tools: false, tool_choice: [], structured_modes: [], structured: 'none' });
  });

  test('tronqué par le raisonnement : inconclusif, un nouvel essai plus large', async () => {
    fake.setScenario('m', [ping(1), scripted.truncated('', { prompt_tokens: 20, completion_tokens: 280 }), scripted.json({ n: 2 }), ping(3)]);
    const p = await probe();
    expect(p.structured).toBe('json_schema');
    expect(fake.requests).toBe(4);
    expect(fake.calls[2]?.body['max_tokens']).toBe(1200);
    expect(p.probe_tokens).toBeGreaterThan(300);
    expect(p.notes.join(' ')).toContain('raisonnement');
  });

  test('auth, quota ou réseau : la sonde échoue au lieu de conclure « non supporté »', async () => {
    fake.setScenario('m', [scripted.error(401, { error: { message: 'Invalid API key' } })]);
    await expect(probe()).rejects.toMatchObject({ class: 'auth' });
  });

  test('détecte le champ de raisonnement', async () => {
    fake.setScenario('m', [{ kind: 'completion', content: null, reasoning: 'hm', toolCalls: [{ name: 'ping', arguments: { n: 1 } }] }, scripted.json({ n: 2 }), ping(3)]);
    expect((await probe()).reasoning_field).toBe('reasoning_content');
  });
});

describe('affectation de rôle et tool_choice', () => {
  const base: CapabilityProfile = { model: 'm', tools: true, tool_choice: ['auto'], structured_modes: [], structured: 'none', stream_tools: null, stream_usage: null, cache: false, reasoning_field: null, probed_at: '', probe_tokens: 0, notes: [] };
  test('agent sans outils ou sans profil refusé ; autres rôles libres', () => {
    expect(roleProblems('agent', { ...base, tools: false })).toHaveLength(1);
    expect(roleProblems('agent', undefined)).toHaveLength(1);
    expect(roleProblems('agent', base)).toEqual([]);
    expect(roleProblems('extract', undefined)).toEqual([]);
  });
  test('tool_choice jamais forcé sans confirmation', () => {
    expect(resolveToolChoice(base, { name: 'go' })).toBeUndefined();
    expect(resolveToolChoice({ ...base, tool_choice: ['named'] }, { name: 'go' })).toEqual({ type: 'function', function: { name: 'go' } });
    expect(resolveToolChoice(base, 'auto')).toBe('auto');
    expect(resolveToolChoice(undefined, 'auto')).toBeUndefined();
  });
});
