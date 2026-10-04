// SPDX-License-Identifier: AGPL-3.0-only
import { Secret } from '@runtime/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createLlmClient, pickLevel, type LlmConfig, type ModelConfig, type ProviderConfig } from './client.js';
import { LlmError } from './errors.js';
import { createFakeProvider, scripted, type FakeProvider } from './fake-provider.js';
import type { CapabilityProfile, LlmRole } from './profile.js';

let fake: FakeProvider;
let fallbackFake: FakeProvider;
beforeEach(async () => {
  fake = await createFakeProvider();
  fallbackFake = await createFakeProvider();
});
afterEach(async () => {
  await fake.close();
  await fallbackFake.close();
});

const profile = (over: Partial<CapabilityProfile> = {}): CapabilityProfile => ({
  model: 'm',
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
  ...over,
});

function setup(opts: { models?: Partial<Record<LlmRole, ModelConfig>>; fallbackRole?: LlmRole; redact?: LlmConfig['redact']; sleeps?: number[] } = {}) {
  const roles: LlmConfig['roles'] = {};
  const primaryModels: ModelConfig[] = [];
  for (const role of ['investigate', 'repair', 'extract', 'agent'] as const) {
    primaryModels.push({ id: role, profile: profile(), ...opts.models?.[role] });
    roles[role] = {
      provider: 'primary',
      model: role,
      ...(opts.fallbackRole === role ? { fallback: { provider: 'backup', model: role } } : {}),
    };
  }
  const providers: ProviderConfig[] = [
    { id: 'primary', baseUrl: fake.baseUrl, apiKey: new Secret('primary-key-0000'), models: primaryModels },
    { id: 'backup', baseUrl: fallbackFake.baseUrl, apiKey: new Secret('backup-key-0000'), models: primaryModels.map((m) => ({ ...m })) },
  ];
  const sleeps = opts.sleeps ?? [];
  const client = createLlmClient(
    { providers, roles, ...(opts.redact ? { redact: opts.redact } : {}) },
    { sleep: async (ms) => void sleeps.push(ms), random: () => 1 },
  );
  return { client, sleeps };
}

const user = (content: string) => [{ role: 'user' as const, content }];

describe('réessais par classe', () => {
  test('429 avec Retry-After : attente respectée puis succès', async () => {
    fake.setScenario('extract', [scripted.error(429, undefined, { 'retry-after': '2' }), scripted.text('ok')]);
    const { client, sleeps } = setup();
    const out = await client.chat('extract', { messages: user('x') });
    expect(out.result.message.content).toBe('ok');
    expect(fake.requests).toBe(2);
    expect(sleeps).toEqual([2000]);
    expect(out.attempts.map((a) => a.failure_class)).toEqual(['llm_rate_limited', null]);
  });

  test('overloaded : 3 réessais puis échec (4 requêtes)', async () => {
    fake.setScenario('extract', Array.from({ length: 4 }, () => scripted.error(503)));
    const { client, sleeps } = setup();
    await expect(client.chat('extract', { messages: user('x') })).rejects.toMatchObject({ class: 'overloaded' });
    expect(fake.requests).toBe(4);
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  test('empty_response : 2 réessais ; timeout : 1 ; network : 2', async () => {
    const { client } = setup();
    fake.setScenario('extract', Array.from({ length: 3 }, () => scripted.empty()));
    await expect(client.chat('extract', { messages: user('x') })).rejects.toMatchObject({ class: 'empty_response' });
    expect(fake.requests).toBe(3);

    fake.reset();
    fake.setScenario('repair', Array.from({ length: 3 }, () => scripted.drop()));
    await expect(client.chat('repair', { messages: user('x') })).rejects.toMatchObject({ class: 'network' });
    expect(fake.requests).toBe(3);

    fake.reset();
    // Marges larges : sous charge, un délai de 50 ms abandonnait la requête avant son arrivée au faux serveur (F-20261001-02).
    fake.setScenario('agent', Array.from({ length: 3 }, () => ({ ...scripted.text('late'), delayMs: 1500 })));
    const t = createLlmClient(
      { providers: [{ id: 'p', baseUrl: fake.baseUrl, apiKey: new Secret('k-0000-0000'), timeoutMs: 200, models: [{ id: 'agent', profile: profile() }] }], roles: { agent: { provider: 'p', model: 'agent' } } },
      { sleep: async () => undefined },
    );
    await expect(t.chat('agent', { messages: user('x') })).rejects.toMatchObject({ class: 'timeout' });
    expect(fake.requests).toBe(2);
  });

  test('bad_request, schema_invalid, truncated : aucun réessai', async () => {
    fake.setScenario('extract', [scripted.error(400, { error: { message: 'bad param' } })]);
    const { client } = setup();
    await expect(client.chat('extract', { messages: user('x') })).rejects.toMatchObject({ class: 'bad_request' });
    expect(fake.requests).toBe(1);
  });

  test('context_length : 1 essai seulement si l\'appelant sait tronquer', async () => {
    const ctx = scripted.error(400, { error: { code: 'context_length_exceeded', message: 'maximum context length' } });
    fake.setScenario('extract', [ctx, scripted.text('ok')]);
    const { client } = setup();
    const out = await client.chat('extract', { messages: user('long'), shrinkInput: () => user('short') });
    expect(out.result.message.content).toBe('ok');
    expect(fake.calls[1]?.body['messages']).toEqual(user('short'));

    fake.reset();
    fake.setScenario('extract', [ctx, ctx]);
    await expect(client.chat('extract', { messages: user('long'), shrinkInput: () => user('short') })).rejects.toMatchObject({ class: 'context_length' });
    expect(fake.requests).toBe(2);
    fake.reset();
    fake.setScenario('extract', [ctx]);
    await expect(client.chat('extract', { messages: user('long') })).rejects.toMatchObject({ class: 'context_length' });
    expect(fake.requests).toBe(1);
  });

  test('truncated : erreur sans réessai, usage facturé imputé au run', async () => {
    fake.setScenario('extract', [scripted.truncated('par', { prompt_tokens: 20, completion_tokens: 8 })]);
    const { client } = setup({ models: { extract: { id: 'extract', price: { in: 1, out: 2 } } } });
    await expect(client.chat('extract', { messages: user('x') })).rejects.toMatchObject({ class: 'truncated' });
    expect(fake.requests).toBe(1);
    expect(client.usage()).toMatchObject({ calls: 1, tokens_in: 20, tokens_out: 8 });
  });
});

describe('assert_llm_no_fallback', () => {
  const FALLBACK_STEP = [scripted.text('depuis le repli')];

  test.each([
    ['llm_refused', scripted.refusal('no'), 'llm_refused'],
    ['auth 401', scripted.error(401, { error: { message: 'Invalid API key' } }), 'auth'],
    ['quota_exhausted (z.ai 1308)', scripted.error(429, { error: { code: '1308', message: 'quota' } }), 'quota_exhausted'],
    ['quota_exhausted 402', scripted.error(402), 'quota_exhausted'],
    ['refus en HTTP 400 content_filter', scripted.error(400, { error: { code: 'content_filter', message: 'blocked' } }), 'llm_refused'],
    ['rate_limited (épuisé)', scripted.error(429), 'rate_limited'],
  ])('%s : aucun repli, le fournisseur de repli reçoit 0 requête', async (_label, step, expected) => {
    fake.setScenario('agent', Array.from({ length: 4 }, () => step));
    fallbackFake.setScenario('agent', FALLBACK_STEP);
    const { client } = setup({ fallbackRole: 'agent' });
    await expect(client.chat('agent', { messages: user('x') })).rejects.toMatchObject({ class: expected });
    expect(fallbackFake.requests).toBe(0);
  });

  test('témoin : overloaded épuisé bascule bien sur le repli (le test n\'est pas vide)', async () => {
    fake.setScenario('agent', Array.from({ length: 4 }, () => scripted.error(503)));
    fallbackFake.setScenario('agent', FALLBACK_STEP);
    const { client } = setup({ fallbackRole: 'agent' });
    const out = await client.chat('agent', { messages: user('x') });
    expect(out.fallback_used).toBe(true);
    expect(out.provider).toBe('backup');
    expect(fallbackFake.requests).toBe(1);
  });

  test('timeout et empty_response éligibles au repli ; sans repli configuré, l\'erreur remonte', async () => {
    fake.setScenario('agent', Array.from({ length: 3 }, () => scripted.empty()));
    fallbackFake.setScenario('agent', FALLBACK_STEP);
    const { client } = setup({ fallbackRole: 'agent' });
    expect((await client.chat('agent', { messages: user('x') })).fallback_used).toBe(true);

    fake.reset();
    fake.setScenario('repair', Array.from({ length: 3 }, () => scripted.empty()));
    await expect(client.chat('repair', { messages: user('x') })).rejects.toMatchObject({ class: 'empty_response' });
  });
});

describe('flux', () => {
  test('flux agrégé : texte, raisonnement, appels d\'outils distingués par id, usage', async () => {
    fake.setScenario('agent', [
      {
        kind: 'completion',
        content: null,
        reasoning: 'je réfléchis',
        toolCalls: [
          { name: 'a', arguments: { x: 1 }, id: 'call_a' },
          { name: 'b', arguments: { y: 2 }, id: 'call_b' },
        ],
        finishReason: 'tool_calls',
        usage: { prompt_tokens: 7, completion_tokens: 3, cached_tokens: 2 },
      },
    ]);
    const { client } = setup();
    const out = await client.call('agent', { messages: user('x'), stream: true, tools: [{ type: 'function', function: { name: 'a', parameters: {} } }] });
    expect(out.result.streamed).toBe(true);
    expect(out.result.message.tool_calls).toEqual([
      { id: 'call_a', type: 'function', function: { name: 'a', arguments: '{"x":1}' } },
      { id: 'call_b', type: 'function', function: { name: 'b', arguments: '{"y":2}' } },
    ]);
    expect(out.result.message['reasoning_content']).toBe('je réfléchis');
    expect(out.usage).toMatchObject({ tokens_in: 7, tokens_out: 3, tokens_cached: 2 });
    expect(fake.calls[0]?.body['stream']).toBe(true);
    expect(fake.calls[0]?.body['stream_options']).toEqual({ include_usage: true });
  });

  test('flux coupé avant finish_reason : stream_error de classe interne network, réessayé', async () => {
    const cut = 'data: {"id":"x","choices":[{"index":0,"delta":{"content":"par"},"finish_reason":null}]}\n\n';
    fake.setScenario('extract', [scripted.raw('text/event-stream', cut), scripted.raw('text/event-stream', cut), scripted.raw('text/event-stream', cut)]);
    const { client } = setup();
    const err = await client.call('extract', { messages: user('x'), stream: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ class: 'stream_error', inner: 'network' });
    expect(fake.requests).toBe(3);
  });

  test('erreur en cours de flux : la table s\'applique au code interne (quota : aucun réessai)', async () => {
    const body = 'data: {"error":{"code":"1308","message":"quota"}}\n\n';
    fake.setScenario('extract', [scripted.raw('text/event-stream', body)]);
    const { client } = setup();
    await expect(client.call('extract', { messages: user('x'), stream: true })).rejects.toMatchObject({ class: 'stream_error', inner: 'quota_exhausted' });
    expect(fake.requests).toBe(1);
  });

  test('outil partiel jamais rendu si le flux ne finit pas par tool_calls', async () => {
    const sse =
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"a","arguments":"{\\"x\\""}}]},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"fin"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    fake.setScenario('extract', [scripted.raw('text/event-stream', sse)]);
    const { client } = setup();
    const out = await client.call('extract', { messages: user('x'), stream: true });
    expect(out.result.message.tool_calls).toBeUndefined();
  });

  test('un serveur qui répond en SSE à stream:false est géré', async () => {
    const sse = 'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    fake.setScenario('extract', [scripted.raw('text/event-stream', sse)]);
    const { client } = setup();
    const out = await client.chat('extract', { messages: user('x') });
    expect(out.result.message.content).toBe('ok');
    expect(out.usage.usage_estimated).toBe(true);
  });
});

describe('messages et outils', () => {
  test('un seul message system, en tête', async () => {
    const { client } = setup();
    await expect(
      client.chat('extract', { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'b' }] }),
    ).rejects.toMatchObject({ class: 'bad_request' });
    expect(fake.requests).toBe(0);
  });

  test('messages assistant verbatim, reasoning_content compris, renvoyés tels quels', async () => {
    fake.setScenario('agent', [scripted.text('ok')]);
    const { client } = setup();
    const assistant = { role: 'assistant' as const, content: null, reasoning_content: 'pensée', tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'a', arguments: '{}' } }], vendor_field: 1 };
    await client.chat('agent', { messages: [...user('x'), assistant, { role: 'tool', tool_call_id: 'c1', content: 'r' }] });
    expect(fake.calls[0]?.body['messages']).toContainEqual(assistant);
  });

  test('tool_choice jamais forcé si le profil ne le confirme pas (z.ai, Ollama, Qwen)', async () => {
    fake.setScenario('agent', [scripted.text('a'), scripted.text('b')]);
    const tools = [{ type: 'function' as const, function: { name: 'go', parameters: {} } }];
    const { client: noForce } = setup({ models: { agent: { id: 'agent', profile: profile({ tool_choice: [] }) } } });
    await noForce.chat('agent', { messages: user('x'), tools, toolChoice: { name: 'go' } });
    expect(fake.calls[0]?.body['tool_choice']).toBeUndefined();
    const { client: force } = setup();
    await force.chat('agent', { messages: user('x'), tools, toolChoice: { name: 'go' } });
    expect(fake.calls[1]?.body['tool_choice']).toEqual({ type: 'function', function: { name: 'go' } });
  });

  test('rôle agent sans outils refusé à la construction', () => {
    expect(() => setup({ models: { agent: { id: 'agent', profile: profile({ tools: false }) } } })).toThrow(/agent exige l'appel d'outils/);
    expect(() => setup({ models: { agent: { id: 'agent', profile: undefined as unknown as CapabilityProfile } } })).toThrow(/profil de capacités absent/);
  });

  test('sessionId et extraBody du fournisseur envoyés dans le corps', async () => {
    fake.setScenario('extract', [scripted.text('ok')]);
    const client = createLlmClient({
      providers: [{ id: 'p', baseUrl: fake.baseUrl, apiKey: new Secret('k-0000-0000'), sessionId: 'sess-1', extraBody: { provider: { require_parameters: true } }, models: [{ id: 'extract' }] }],
      roles: { extract: { provider: 'p', model: 'extract' } },
    });
    await client.chat('extract', { messages: user('x') });
    expect(fake.calls[0]?.body).toMatchObject({ session_id: 'sess-1', provider: { require_parameters: true }, stream: false });
  });

  test('la clé n\'apparaît que dans Authorization, jamais dans les erreurs', async () => {
    fake.setScenario('extract', [scripted.error(401, { error: { message: 'Invalid API key primary-key-0000' } })]);
    const { client } = setup();
    const err = (await client.chat('extract', { messages: user('x') }).catch((e: unknown) => e)) as LlmError;
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain('primary-key-0000');
    expect(fake.calls[0]?.headers['authorization']).toBeUndefined(); // le faux ne l'enregistre jamais
  });
});

describe('sortie structurée S1-S4 + Ajv final (INV1)', () => {
  const schema = {
    type: 'object',
    properties: { title: { type: 'string', minLength: 2 }, price: { type: 'number' }, note: { type: 'string' } },
    required: ['title', 'price'],
  };

  test('niveau choisi d\'après le profil', () => {
    expect(pickLevel(profile())).toBe('S1');
    expect(pickLevel(profile({ structured_modes: ['tool_forced', 'json_object'] }))).toBe('S2');
    expect(pickLevel(profile({ structured_modes: ['tool_forced'], tool_choice: [] }))).toBe('S4');
    expect(pickLevel(profile({ structured_modes: ['json_object'] }))).toBe('S3');
    expect(pickLevel(profile({ structured_modes: [], structured: 'none' }))).toBe('S4');
    expect(pickLevel(undefined)).toBe('S4');
  });

  test('S1 : response_format json_schema strict avec schéma de transport ; null des optionnels retiré', async () => {
    fake.setScenario('extract', [scripted.json({ title: 'Livre', price: 12.5, note: null })]);
    const { client } = setup();
    const out = await client.generateStructured('extract', { messages: user('x'), schema, name: 'produit' });
    expect(out).toMatchObject({ level: 'S1', repairs: 0, value: { title: 'Livre', price: 12.5 } });
    const sent = fake.calls[0]?.body['response_format'] as { type: string; json_schema: { strict: boolean; name: string; schema: { required: string[]; additionalProperties: boolean } } };
    expect(sent.type).toBe('json_schema');
    expect(sent.json_schema).toMatchObject({ strict: true, name: 'produit' });
    expect(sent.json_schema.schema.required).toEqual(['title', 'price', 'note']);
    expect(sent.json_schema.schema.additionalProperties).toBe(false);
  });

  test('S2 : outil unique forcé', async () => {
    fake.setScenario('extract', [scripted.toolCalls([{ name: 'submit_result', arguments: { title: 'Livre', price: 1, note: null } }])]);
    const { client } = setup();
    const out = await client.generateStructured('extract', { messages: user('x'), schema, level: 'S2' });
    expect(out.value).toEqual({ title: 'Livre', price: 1 });
    expect(fake.calls[0]?.body['tool_choice']).toEqual({ type: 'function', function: { name: 'submit_result' } });
    expect(fake.calls[0]?.body['response_format']).toBeUndefined();
  });

  test('S3 : json_object avec le schéma dans le message system de tête', async () => {
    fake.setScenario('extract', [scripted.json({ title: 'Livre', price: 1, note: null })]);
    const { client } = setup();
    await client.generateStructured('extract', { messages: [{ role: 'system', content: 'Tu extrais.' }, ...user('x')], schema, level: 'S3' });
    const messages = fake.calls[0]?.body['messages'] as { role: string; content: string }[];
    expect(fake.calls[0]?.body['response_format']).toEqual({ type: 'json_object' });
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(messages[0]?.content).toContain('Tu extrais.');
    expect(messages[0]?.content).toContain('JSON Schema');
  });

  test('S4 : JSON extrait d\'un texte bavard', async () => {
    fake.setScenario('extract', [scripted.text('Voici le résultat : {"title":"Livre","price":3,"note":null} Bonne journée !')]);
    const { client } = setup();
    const out = await client.generateStructured('extract', { messages: user('x'), schema, level: 'S4' });
    expect(out).toMatchObject({ level: 'S4', value: { title: 'Livre', price: 3 } });
    expect(fake.calls[0]?.body['response_format']).toBeUndefined();
  });

  test('prose malgré json_schema (z.ai) : réparation puis succès', async () => {
    fake.setScenario('extract', [scripted.text('Désolé, voici une description en prose.'), scripted.json({ title: 'Livre', price: 2, note: null })]);
    const { client } = setup();
    const out = await client.generateStructured('extract', { messages: user('x'), schema });
    expect(out.repairs).toBe(1);
    const second = fake.calls[1]?.body['messages'] as { role: string; content: string }[];
    expect(second.at(-1)?.content).toContain('invalid');
  });

  test('hors schéma après 2 réparations : schema_invalid, jamais un succès', async () => {
    const bad = scripted.json({ title: 'A', price: 'cher', note: null });
    fake.setScenario('extract', [bad, bad, bad, bad]);
    const { client } = setup();
    const err = await client.generateStructured('extract', { messages: user('x'), schema }).catch((e: unknown) => e);
    expect(err).toMatchObject({ class: 'schema_invalid', failureClass: 'llm_schema_invalid' });
    expect(fake.requests).toBe(3);
    expect(String((err as Error).message)).not.toContain('cher');
  });

  test('Ajv valide contre le schéma d\'ORIGINE : une contrainte déplacée en description est appliquée', async () => {
    const strict = { type: 'object', properties: { code: { type: 'string', pattern: '^[A-Z]{3}$' } }, required: ['code'] };
    const bad = scripted.json({ code: 'abc' });
    fake.setScenario('extract', [bad, bad, bad]);
    const { client } = setup();
    await expect(client.generateStructured('extract', { messages: user('x'), schema: strict })).rejects.toMatchObject({ class: 'schema_invalid' });
    fake.reset();
    fake.setScenario('extract', [scripted.json({ code: 'ABC' })]);
    await expect(client.generateStructured('extract', { messages: user('x'), schema: strict })).resolves.toMatchObject({ value: { code: 'ABC' } });
  });

  test('finish_reason length => truncated (pas de réparation)', async () => {
    fake.setScenario('extract', [scripted.truncated('{"title":"Li')]);
    const { client } = setup();
    await expect(client.generateStructured('extract', { messages: user('x'), schema })).rejects.toMatchObject({ class: 'truncated' });
    expect(fake.requests).toBe(1);
  });

  test('racine tableau : enveloppée au transport, déballée au retour', async () => {
    fake.setScenario('extract', [scripted.json({ result: ['a', 'b'] })]);
    const { client } = setup();
    const out = await client.generateStructured('extract', { messages: user('x'), schema: { type: 'array', items: { type: 'string' } } });
    expect(out.value).toEqual(['a', 'b']);
  });

  test('$ref distant : refusé avant tout appel', async () => {
    const { client } = setup();
    await expect(client.generateStructured('extract', { messages: user('x'), schema: { type: 'object', properties: { a: { $ref: 'https://evil.example/s.json' } } } })).rejects.toMatchObject({ class: 'bad_request' });
    expect(fake.requests).toBe(0);
  });
});

describe('assert_llm_redaction', () => {
  const FIXTURE =
    'Contact : jean.dupont@example.org ou +33 6 12 34 56 78, bureau 01 23 45 67 89 ; (555) 123-4567. ' +
    'Matricule INT-884213 et clé de dossier cle-fixture-0000.';

  test('le corps capturé côté faux fournisseur ne contient aucun e-mail ni téléphone de la fixture', async () => {
    fake.setScenario('extract', [scripted.text('ok')]);
    const { client } = setup({ redact: { patterns: ['INT-\\d{6}'] } });
    await client.chat('extract', {
      messages: [
        { role: 'system', content: 'Tu extrais. Support : help@corp.example' },
        { role: 'user', content: [{ type: 'text', text: FIXTURE }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"mail":"a.b@c.fr"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: FIXTURE },
      ],
    });
    const sent = JSON.stringify(fake.calls[0]?.body);
    expect(sent).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    expect(sent).not.toMatch(/\+33|06 12|01 23 45|555\) 123|123-4567/);
    expect(sent).not.toContain('INT-884213');
    expect(sent).toContain('[email]');
    expect(sent).toContain('[téléphone]');
  });

  test('témoin : sans llm.redact, la fixture part en clair', async () => {
    fake.setScenario('extract', [scripted.text('ok')]);
    const { client } = setup();
    await client.chat('extract', { messages: user(FIXTURE) });
    expect(JSON.stringify(fake.calls[0]?.body)).toContain('jean.dupont@example.org');
  });

  test('les valeurs de secret connues du processus sont aussi masquées', async () => {
    const { secretValues } = await import('@runtime/core');
    secretValues.add('zz-secret-value-12345');
    try {
      fake.setScenario('extract', [scripted.text('ok')]);
      const { client } = setup({ redact: {} });
      await client.chat('extract', { messages: user('jeton zz-secret-value-12345 fin') });
      expect(JSON.stringify(fake.calls[0]?.body)).not.toContain('zz-secret-value-12345');
    } finally {
      secretValues.delete('zz-secret-value-12345');
    }
  });

  test('les redactions ne touchent pas les dates ni les nombres ordinaires', async () => {
    fake.setScenario('extract', [scripted.text('ok')]);
    const { client } = setup({ redact: {} });
    await client.chat('extract', { messages: user('2026-10-01 12:30, prix 1234567.89, ref 12345678') });
    expect(JSON.stringify(fake.calls[0]?.body)).toContain('2026-10-01 12:30, prix 1234567.89, ref 12345678');
  });
});

describe('garde avant chaque appel (plafond de coût de l’essai, tâche 2.4)', () => {
  const priced = { type: 'object', properties: { title: { type: 'string' }, price: { type: 'number' } }, required: ['title', 'price'], additionalProperties: false } as const;
  test('beforeCall lève avant l’envoi : aucune requête de plus, ni réessai ni réparation ni repli, l’erreur remonte telle quelle', async () => {
    const bad = scripted.json({ title: 'Livre', price: 'cher' });
    fake.setScenario('extract', [bad, bad, bad]);
    const { client } = setup({ fallbackRole: 'extract' });
    let calls = 0;
    const stop = new Error('zz_test_budget');
    const beforeCall = () => {
      calls += 1;
      if (calls > 1) throw stop;
    };
    await expect(client.generateStructured('extract', { messages: user('x'), schema: priced, beforeCall })).rejects.toBe(stop);
    // Une seule requête : la réparation suivante est refusée AVANT l’envoi.
    expect(fake.requests).toBe(1);
    expect(fallbackFake.requests).toBe(0);
    expect(calls).toBe(2);

    fake.reset();
    fake.setScenario('extract', [scripted.error(503), scripted.text('ok')]);
    await expect(client.chat('extract', { messages: user('x'), beforeCall: () => { throw stop; } })).rejects.toBe(stop);
    expect(fake.requests).toBe(0);
  });
});

describe('coût prévu de l’appel passé à beforeCall (UX-32)', () => {
  test('entrée estimée sur la requête envoyée (caractères / 4), sortie sur le dernier appel ; null sans prix', async () => {
    const bad = scripted.json({ title: 'Livre', price: 'cher' }, { prompt_tokens: 100, completion_tokens: 1_000 });
    fake.setScenario('extract', [bad, scripted.json({ title: 'Livre', price: 3 })]);
    const PRICE_IN = 1;
    const PRICE_OUT = 2;
    const { client } = setup({ models: { extract: { id: 'extract', price: { in: PRICE_IN, out: PRICE_OUT } } } });
    const seen: (number | null)[] = [];
    const schema = { type: 'object', properties: { title: { type: 'string' }, price: { type: 'number' } }, required: ['title', 'price'], additionalProperties: false } as const;
    await client.generateStructured('extract', { messages: user('x'.repeat(4_000)), schema, beforeCall: (call) => void seen.push(call?.estimateUsd ?? null) });
    expect(seen).toHaveLength(2);
    // 1er appel : au moins 1 000 jetons d'entrée (4 000 caractères), aucune sortie connue.
    expect(seen[0]).toBeGreaterThanOrEqual(1_000 * PRICE_IN / 1e6);
    // Réparation : la sortie du 1er appel (1 000 jetons) est attendue de nouveau.
    expect(seen[1]!).toBeGreaterThanOrEqual(seen[0]! + 1_000 * PRICE_OUT / 1e6);
    fake.setScenario('extract', [scripted.text('ok')]);
    const unpriced: unknown[] = [];
    await setup().client.chat('extract', { messages: user('x'), beforeCall: (call) => void unpriced.push(call?.estimateUsd) });
    expect(unpriced).toEqual([null]);
  });
});

describe('échantillonnage non supporté (D-42 : claude-opus-4-8 compatible OpenAI répond 400 à temperature et top_p)', () => {
  const noSampling = profile({ sampling: { temperature: false, top_p: false } });

  test('le profil retire temperature et top_p de la requête envoyée, une seule note de journal par paramètre', async () => {
    fake.setScenario('agent', [scripted.text('un'), scripted.text('deux')]);
    const notes: unknown[] = [];
    const { client } = setupWithNotes({ agent: { id: 'agent', profile: noSampling } }, notes);
    await client.chat('agent', { messages: user('x'), temperature: 0, topP: 0.9, maxTokens: 50 });
    await client.chat('agent', { messages: user('y'), temperature: 0, topP: 0.9, maxTokens: 50 });
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(call.body).not.toHaveProperty('temperature');
      expect(call.body).not.toHaveProperty('top_p');
      expect(call.body['max_tokens']).toBe(50);
    }
    expect(notes).toEqual([
      { event: 'llm_sampling_param_dropped', provider: 'primary', model: 'agent', param: 'temperature' },
      { event: 'llm_sampling_param_dropped', provider: 'primary', model: 'agent', param: 'top_p' },
    ]);
  });

  test('profil qui accepte l’échantillonnage, ou sans mesure : requête inchangée, aucune note', async () => {
    fake.setScenario('agent', [scripted.text('un')]);
    fake.setScenario('extract', [scripted.text('deux')]);
    const notes: unknown[] = [];
    const { client } = setupWithNotes({ agent: { id: 'agent', profile: profile({ sampling: { temperature: true, top_p: true } }) }, extract: { id: 'extract', profile: profile() } }, notes);
    await client.chat('agent', { messages: user('x'), temperature: 0, topP: 0.5 });
    await client.chat('extract', { messages: user('x'), temperature: 0 });
    expect(fake.calls[0]?.body).toMatchObject({ temperature: 0, top_p: 0.5 });
    expect(fake.calls[1]?.body).toMatchObject({ temperature: 0 });
    expect(notes).toEqual([]);
  });

  test('le repli a son propre profil : retrait selon la cible réellement appelée', async () => {
    fake.setScenario('agent', [scripted.error(503), scripted.error(503), scripted.error(503), scripted.error(503)]);
    fallbackFake.setScenario('agent', [scripted.text('secours')]);
    const notes: unknown[] = [];
    const { client } = setupWithNotes({ agent: { id: 'agent', profile: profile({ sampling: { temperature: true, top_p: true } }) } }, notes, 'agent', { agent: { id: 'agent', profile: noSampling } });
    const out = await client.chat('agent', { messages: user('x'), temperature: 0 });
    expect(out.fallback_used).toBe(true);
    expect(fake.calls.every((c) => c.body['temperature'] === 0)).toBe(true);
    expect(fallbackFake.calls[0]?.body).not.toHaveProperty('temperature');
    expect(notes).toEqual([{ event: 'llm_sampling_param_dropped', provider: 'backup', model: 'agent', param: 'temperature' }]);
  });
});

describe('repli sans profil sondé : 400 qui nomme temperature ou top_p (production avant la route de sonde)', () => {
  const deprecated = (param: string) => scripted.error(400, { error: { message: `\`${param}\` is deprecated for this model.`, type: 'invalid_request_error' } });

  test('un nouvel essai sans le paramètre nommé, noté llm_sampling_param_rejected, retenu pour les appels suivants', async () => {
    fake.setScenario('agent', [deprecated('temperature'), scripted.text('ok'), scripted.text('encore')]);
    const notes: unknown[] = [];
    const { client } = setupWithNotes({}, notes);
    const out = await client.chat('agent', { messages: user('x'), temperature: 0, maxTokens: 50 });
    expect(out.result.message.content).toBe('ok');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.body).toMatchObject({ temperature: 0 });
    expect(fake.calls[1]?.body).not.toHaveProperty('temperature');
    expect(fake.calls[1]?.body['max_tokens']).toBe(50);
    expect(out.attempts.map((a) => a.failure_class)).toEqual(['llm_bad_request', null]);
    await client.chat('agent', { messages: user('y'), temperature: 0 });
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]?.body).not.toHaveProperty('temperature');
    expect(notes).toEqual([{ event: 'llm_sampling_param_rejected', provider: 'primary', model: 'agent', param: 'temperature' }]);
  });

  test('temperature puis top_p refusés l’un après l’autre : un essai par paramètre, pas plus', async () => {
    fake.setScenario('agent', [deprecated('temperature'), deprecated('top_p'), scripted.text('ok')]);
    const notes: unknown[] = [];
    const { client } = setupWithNotes({}, notes);
    await client.chat('agent', { messages: user('x'), temperature: 0, topP: 0.9 });
    expect(fake.calls).toHaveLength(3);
    expect(fake.calls[2]?.body).not.toHaveProperty('temperature');
    expect(fake.calls[2]?.body).not.toHaveProperty('top_p');
    expect(notes).toHaveLength(2);
  });

  test('400 qui ne nomme aucun paramètre envoyé : pas de nouvel essai', async () => {
    fake.setScenario('agent', [deprecated('temperature'), scripted.text('jamais')]);
    const { client } = setupWithNotes({}, []);
    await expect(client.chat('agent', { messages: user('x'), topP: 0.9 })).rejects.toMatchObject({ class: 'bad_request' });
    fake.setScenario('extract', [scripted.error(400, { error: { message: 'unsupported parameter' } }), scripted.text('jamais')]);
    await expect(client.chat('extract', { messages: user('x'), temperature: 0 })).rejects.toMatchObject({ class: 'bad_request' });
    expect(fake.calls).toHaveLength(2);
  });
});

function setupWithNotes(models: Partial<Record<LlmRole, ModelConfig>>, notes: unknown[], fallbackRole?: LlmRole, backupModels: Partial<Record<LlmRole, ModelConfig>> = {}) {
  const roles: LlmConfig['roles'] = {};
  const primaryModels: ModelConfig[] = [];
  for (const role of ['investigate', 'repair', 'extract', 'agent'] as const) {
    primaryModels.push({ id: role, profile: profile(), ...models[role] });
    roles[role] = { provider: 'primary', model: role, ...(fallbackRole === role ? { fallback: { provider: 'backup', model: role } } : {}) };
  }
  const providers: ProviderConfig[] = [
    { id: 'primary', baseUrl: fake.baseUrl, apiKey: new Secret('primary-key-0000'), models: primaryModels },
    { id: 'backup', baseUrl: fallbackFake.baseUrl, apiKey: new Secret('backup-key-0000'), models: primaryModels.map((m) => ({ ...m, ...backupModels[m.id as LlmRole] })) },
  ];
  return { client: createLlmClient({ providers, roles }, { sleep: async () => undefined, random: () => 1, note: (n) => void notes.push(n) }) };
}
