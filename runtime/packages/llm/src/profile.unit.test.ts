// SPDX-License-Identifier: AGPL-3.0-only
import { Secret } from '@runtime/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createFakeProvider, scripted, type FakeProvider } from './fake-provider.js';
import { probeCapabilities, resolveToolChoice, roleProblems, withoutUnsupportedSampling, type CapabilityProfile } from './profile.js';
import { OpenAICompatTransport } from './transport.js';

let fake: FakeProvider;
beforeEach(async () => {
  fake = await createFakeProvider();
});
afterEach(() => fake.close());

const transport = () => new OpenAICompatTransport({ baseUrl: fake.baseUrl, apiKey: new Secret('k-0000-0000') });
const ping = (n: number) => scripted.toolCalls([{ name: 'ping', arguments: { n } }], { prompt_tokens: 50, completion_tokens: 10, cached_tokens: 0 });
/** Sortie d'un modèle dont le schéma est réellement imposé : le jeton ne figure nulle part dans le prompt. */
const enforced = () => scripted.json({ probe_token: 'zq7' });
const SAMPLING_OK = [scripted.text('ok'), scripted.text('ok')];
const bad = (param: string) => scripted.error(400, { error: { message: `\`${param}\` is deprecated for this model.` } });
const probe = () => probeCapabilities(transport(), 'm', () => new Date('2026-10-01T00:00:00Z'));

describe('sonde de capacités', () => {
  test('modèle complet : outils, tool_choice, json_schema, cache', async () => {
    fake.setScenario('m', [ping(1), enforced(), ping(3), ...SAMPLING_OK]);
    const p = await probe();
    expect(p).toMatchObject({ tools: true, tool_choice: ['auto', 'named'], structured: 'json_schema', cache: true, stream_tools: null, stream_usage: null, sampling: { temperature: true, top_p: true } });
    expect(p.structured_modes).toEqual(['json_schema', 'tool_forced', 'json_object']);
    expect(fake.requests).toBe(5);
    expect(fake.calls.every((c) => c.body['stream'] === false)).toBe(true);
    expect(fake.calls.every((c) => (c.body['max_tokens'] as number) <= 300)).toBe(true);
  });

  test('z.ai : json_schema accepté puis prose (HTTP 200) => pas de json_schema, appel forcé non confirmé', async () => {
    fake.setScenario('m', [ping(1), scripted.text('Voici une description en prose.'), scripted.text('Je préfère répondre en texte.'), ...SAMPLING_OK]);
    const p = await probe();
    expect(p.structured_modes).toEqual(['json_object']);
    expect(p.tool_choice).toEqual(['auto']);
    expect(p.structured).toBe('json_object');
    expect(p.notes.join(' ')).toContain('prose');
  });

  test('modèle sans outils ni response_format (4xx) : profil minimal, structured none', async () => {
    const reject = scripted.error(400, { error: { message: 'unsupported parameter' } });
    fake.setScenario('m', [reject, reject, reject, ...SAMPLING_OK]);
    const p = await probe();
    expect(p).toMatchObject({ tools: false, tool_choice: [], structured_modes: [], structured: 'none' });
  });

  test('tronqué par le raisonnement : inconclusif, un nouvel essai plus large', async () => {
    fake.setScenario('m', [ping(1), scripted.truncated('', { prompt_tokens: 20, completion_tokens: 280 }), enforced(), ping(3), ...SAMPLING_OK]);
    const p = await probe();
    expect(p.structured).toBe('json_schema');
    expect(fake.requests).toBe(6);
    expect(fake.calls[2]?.body['max_tokens']).toBe(1200);
    expect(p.probe_tokens).toBeGreaterThan(300);
    expect(p.notes.join(' ')).toContain('raisonnement');
  });

  test('auth, quota ou réseau : la sonde échoue au lieu de conclure « non supporté »', async () => {
    fake.setScenario('m', [scripted.error(401, { error: { message: 'Invalid API key' } })]);
    await expect(probe()).rejects.toMatchObject({ class: 'auth' });
  });

  test('détecte le champ de raisonnement', async () => {
    fake.setScenario('m', [{ kind: 'completion', content: null, reasoning: 'hm', toolCalls: [{ name: 'ping', arguments: { n: 1 } }] }, enforced(), ping(3), ...SAMPLING_OK]);
    expect((await probe()).reasoning_field).toBe('reasoning_content');
  });
});

describe('sonde : le json_schema n\'est conclu que s\'il est réellement imposé (D-42)', () => {
  test('le prompt ne révèle ni le nom du champ ni la valeur attendue', async () => {
    fake.setScenario('m', [ping(1), enforced(), ping(3), ...SAMPLING_OK]);
    await probe();
    const call = fake.calls[1]?.body as { messages: { content: string }[]; response_format: { json_schema: { schema: { properties: Record<string, { enum?: string[] }>; required: string[] } } } };
    const [field] = call.response_format.json_schema.schema.required;
    const expected = call.response_format.json_schema.schema.properties[field ?? '']?.enum?.[0];
    expect(field).toBeDefined();
    expect(expected).toBeDefined();
    const prompt = call.messages.map((m) => m.content).join(' ');
    expect(prompt).not.toContain(field);
    expect(prompt).not.toContain(expected);
  });

  test('fournisseur qui ignore response_format (réponse en prose ou à côté du schéma) : pas de json_schema, tool_forced retenu', async () => {
    // Cas réel chez certains fournisseurs (z.ai) : response_format accepté (HTTP 200) mais non imposé. Un modèle qui n'obéit qu'au prompt ne peut pas deviner le jeton.
    fake.setScenario('m', [ping(1), scripted.text('Sure, what result should I fill in?'), ping(3), ...SAMPLING_OK]);
    const p = await probe();
    expect(p.structured_modes).toEqual(['tool_forced', 'json_object']);
    expect(p.structured).toBe('tool_forced');
    expect(p.notes.join(' ')).toContain('prose');
  });

  test('JSON valide mais jeton absent ou faux : non imposé', async () => {
    fake.setScenario('m', [ping(1), scripted.json({ n: 2 }), ping(3), ...SAMPLING_OK]);
    expect((await probe()).structured).toBe('tool_forced');
    fake.setScenario('m2', [ping(1), scripted.json({ probe_token: 'autre' }), ping(3), ...SAMPLING_OK]);
    expect((await probeCapabilities(transport(), 'm2', () => new Date('2026-10-01T00:00:00Z'))).structured).toBe('tool_forced');
  });
});

describe('sonde : prise en charge de temperature et top_p', () => {
  test('deux appels minuscules, un paramètre chacun ; acceptés => true', async () => {
    fake.setScenario('m', [ping(1), enforced(), ping(3), ...SAMPLING_OK]);
    const p = await probe();
    expect(p.sampling).toEqual({ temperature: true, top_p: true });
    const [t, tp] = fake.calls.slice(3);
    expect(t?.body).toMatchObject({ temperature: 0 });
    expect(t?.body).not.toHaveProperty('top_p');
    expect(tp?.body).toMatchObject({ top_p: 0.9 });
    expect(tp?.body).not.toHaveProperty('temperature');
    expect(fake.calls.slice(3).every((c) => (c.body['max_tokens'] as number) <= 16)).toBe(true);
  });

  test('400 sur temperature et sur top_p (claude-opus-4-8 compatible OpenAI) => false, false, noté', async () => {
    fake.setScenario('m', [ping(1), scripted.text('prose'), ping(3), bad('temperature'), bad('top_p')]);
    const p = await probe();
    expect(p.sampling).toEqual({ temperature: false, top_p: false });
    expect(p.notes.join(' ')).toContain('temperature');
    expect(p.notes.join(' ')).toContain('top_p');
  });

  test('seul temperature refusé', async () => {
    fake.setScenario('m', [ping(1), enforced(), ping(3), bad('temperature'), scripted.text('ok')]);
    expect((await probe()).sampling).toEqual({ temperature: false, top_p: true });
  });

  test('réponse tronquée (modèle à raisonnement) : le paramètre a été accepté', async () => {
    fake.setScenario('m', [ping(1), enforced(), ping(3), scripted.truncated('', { prompt_tokens: 10, completion_tokens: 16 }), scripted.truncated('', { prompt_tokens: 10, completion_tokens: 16 })]);
    expect((await probe()).sampling).toEqual({ temperature: true, top_p: true });
  });

  test('auth ou quota pendant la sonde de sampling : la sonde échoue, ne conclut pas « non supporté »', async () => {
    fake.setScenario('m', [ping(1), enforced(), ping(3), scripted.error(401, { error: { message: 'Invalid API key' } })]);
    await expect(probe()).rejects.toMatchObject({ class: 'auth' });
  });
});

describe('withoutUnsupportedSampling', () => {
  const base: CapabilityProfile = { model: 'm', tools: true, tool_choice: [], structured_modes: [], structured: 'none', stream_tools: null, stream_usage: null, cache: false, reasoning_field: null, probed_at: '', probe_tokens: 0, notes: [] };
  test('profil sans information ou paramètres pris en charge : requête inchangée', () => {
    const req = { model: 'm', messages: [], temperature: 0 };
    expect(withoutUnsupportedSampling(undefined, req)).toEqual({ request: req, dropped: [] });
    expect(withoutUnsupportedSampling(base, req)).toEqual({ request: req, dropped: [] });
    expect(withoutUnsupportedSampling({ ...base, sampling: { temperature: true, top_p: true } }, req)).toEqual({ request: req, dropped: [] });
  });
  test('paramètre refusé : retiré de la requête, signalé ; le reste est intact', () => {
    const req = { model: 'm', messages: [], temperature: 0, top_p: 0.5, max_tokens: 5 };
    const out = withoutUnsupportedSampling({ ...base, sampling: { temperature: false, top_p: true } }, req);
    expect(out.dropped).toEqual(['temperature']);
    expect(out.request).toEqual({ model: 'm', messages: [], top_p: 0.5, max_tokens: 5 });
    expect(withoutUnsupportedSampling({ ...base, sampling: { temperature: false, top_p: false } }, req).dropped).toEqual(['temperature', 'top_p']);
    expect(withoutUnsupportedSampling({ ...base, sampling: { temperature: false, top_p: false } }, { model: 'm', messages: [] }).dropped).toEqual([]);
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
