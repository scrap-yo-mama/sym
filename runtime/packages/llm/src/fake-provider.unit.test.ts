// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, test } from 'vitest';
import { createFakeProvider, scripted, type FakeProvider } from './fake-provider.js';

let fake: FakeProvider | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer zz', ...headers }, body: JSON.stringify(body) });

describe('faux fournisseur scripté', () => {
  test('scénarios par rôle (modèle ou en-tête) et par étape, compteur de requêtes', async () => {
    fake = await createFakeProvider({ scenarios: { enquete: [scripted.text('e0'), scripted.text('e1')], other: [scripted.text('o0')] } });
    const read = async (r: Response) => ((await r.json()) as { choices: { message: { content: string } }[] }).choices[0]?.message.content;
    expect(await read(await post(fake.baseUrl, { model: 'enquete', messages: [] }))).toBe('e0');
    expect(await read(await post(fake.baseUrl, { model: 'enquete', messages: [] }))).toBe('e1');
    expect(await read(await post(fake.baseUrl, { model: 'm', messages: [] }, { 'x-fake-role': 'other' }))).toBe('o0');
    expect(fake.requests).toBe(3);
    expect(fake.byRole).toEqual({ enquete: 2, other: 1 });
    expect(fake.calls[2]?.headers['authorization']).toBeUndefined();
  });

  test('scénario épuisé : 500 et requête notée dans unscripted (mode strict)', async () => {
    fake = await createFakeProvider({ scenarios: { a: [scripted.text('x')] } });
    await post(fake.baseUrl, { model: 'a', messages: [] });
    const res = await post(fake.baseUrl, { model: 'a', messages: [] });
    expect(res.status).toBe(500);
    expect(fake.unscripted).toEqual([{ role: 'a', step: 1 }]);
  });

  test('étape fonctionnelle : la réponse dépend du corps reçu', async () => {
    fake = await createFakeProvider({ scenarios: { a: [({ body }) => scripted.text(`n=${(body['messages'] as unknown[]).length}`)] } });
    const r = await post(fake.baseUrl, { model: 'a', messages: [1, 2, 3] });
    expect(JSON.stringify(await r.json())).toContain('n=3');
  });

  test('point d\'observation des appels d\'outils : hors liste et exécuté', async () => {
    fake = await createFakeProvider({
      scenarios: {
        agent: [
          scripted.toolCalls([
            { name: 'click', arguments: { sel: '#a' }, id: 'c1' },
            { name: 'exfiltrate', arguments: { to: 'evil.example' }, id: 'c2' },
          ]),
          scripted.text('fin'),
        ],
      },
    });
    const tools = [{ type: 'function', function: { name: 'click', parameters: {} } }];
    await post(fake.baseUrl, { model: 'agent', messages: [], tools });
    await post(fake.baseUrl, { model: 'agent', messages: [{ role: 'tool', tool_call_id: 'c1', content: 'ok' }], tools });
    const observed = fake.observeToolCalls();
    expect(observed.map((o) => [o.name, o.inList, o.answered])).toEqual([
      ['click', true, true],
      ['exfiltrate', false, false],
    ]);
    expect(fake.offListToolCalls().map((o) => o.name)).toEqual(['exfiltrate']);
  });

  test('rejeu identique : deux instances avec le même scénario donnent les mêmes réponses', async () => {
    const run = async () => {
      const f = await createFakeProvider({ scenarios: { a: [scripted.json({ v: 1 }), scripted.error(429)] } });
      try {
        const a = await (await post(f.baseUrl, { model: 'a', messages: [] })).text();
        const b = (await post(f.baseUrl, { model: 'a', messages: [] })).status;
        return [a.replace(/"id":"[^"]+"/, ''), b];
      } finally {
        await f.close();
      }
    };
    expect(await run()).toEqual(await run());
  });
});
