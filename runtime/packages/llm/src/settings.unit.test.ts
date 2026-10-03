// SPDX-License-Identifier: AGPL-3.0-only
// `settings.llm` (08 §7) → configuration du client : clés lues dans le dépôt de secrets, rôles demandés seulement.
import { Secret } from '@runtime/core';
import { describe, expect, it } from 'vitest';
import { llmConfigFromSettings, LlmSettingsError, roleTarget } from './settings.js';

const SETTINGS = {
  providers: [
    {
      id: 'zai',
      preset: 'zai',
      base_url: 'https://zz-test.invalid/v1',
      api_key_secret_id: 'sec-1',
      timeout_ms: 120000,
      models: { 'glm-5.3': { profile: { tools: true, tool_choice: ['auto'], structured: 'json_object', cache: true }, price: { in: 0.5, out: 2 } } },
    },
    { id: 'unused', base_url: 'https://zz-unused.invalid/v1', api_key_secret_id: 'sec-missing', models: {} },
  ],
  roles: { extract: { provider: 'zai', model: 'glm-5.3' }, agent: { provider: 'zai', model: 'glm-5.3' }, repair: { provider: 'unused', model: 'm' } },
  redact: { enabled: true, patterns: ['email', 'phone', 'ZZ-[0-9]+'] },
};

const read = async (id: string): Promise<Secret> => {
  if (id === 'sec-1') return new Secret('zz_test_key_value');
  throw new Error('secret absent');
};

describe('llmConfigFromSettings', () => {
  it('rôles demandés, profil et prix, clé lue au dépôt ; fournisseur inutilisé non résolu', async () => {
    const config = await llmConfigFromSettings(SETTINGS, read, ['extract', 'agent']);
    expect(config.providers.map((p) => p.id)).toEqual(['zai']);
    expect(config.roles).toEqual({ extract: { provider: 'zai', model: 'glm-5.3' }, agent: { provider: 'zai', model: 'glm-5.3' } });
    expect(config.providers[0]?.models[0]).toMatchObject({ id: 'glm-5.3', price: { in: 0.5, out: 2 }, profile: { structured: 'json_object', structured_modes: ['json_object'], tool_choice: ['auto'] } });
    expect(config.redact).toEqual({ patterns: ['ZZ-[0-9]+'] });
    const agent = roleTarget(config, 'agent');
    expect(agent?.provider.apiKey.reveal()).toBe('zz_test_key_value');
    expect(agent?.model.id).toBe('glm-5.3');
  });

  it('échantillonnage mesuré par la sonde : conservé dans le profil ; absent ou malformé : pas de restriction', async () => {
    const withSampling = (sampling: unknown) => ({ ...SETTINGS, providers: [{ ...SETTINGS.providers[0]!, models: { 'glm-5.3': { profile: { tools: true, sampling } } } }] });
    const sampling = async (raw: unknown) => (await llmConfigFromSettings(withSampling(raw), read, ['agent'])).providers[0]?.models[0]?.profile?.sampling;
    expect(await sampling({ temperature: false, top_p: false })).toEqual({ temperature: false, top_p: false });
    expect(await sampling({ temperature: false, top_p: true })).toEqual({ temperature: false, top_p: true });
    expect(await sampling({ temperature: false })).toEqual({ temperature: false, top_p: true });
    expect(await sampling(undefined)).toBeUndefined();
    expect(await sampling('non')).toBeUndefined();
  });

  it('en-têtes du fournisseur (`headers_secret_id`, 08 § 1) : lus au dépôt et envoyés par les runs comme par « Tester »', async () => {
    const withHeaders = { ...SETTINGS, providers: [{ ...SETTINGS.providers[0]!, headers_secret_id: 'sec-h' }] };
    const readH = async (id: string): Promise<Secret> => (id === 'sec-h' ? new Secret(JSON.stringify({ 'X-Zz-Tenant': 'zz_test_tenant' })) : read(id));
    const config = await llmConfigFromSettings(withHeaders, readH, ['extract']);
    const headers = config.providers[0]?.headers ?? {};
    expect(Object.keys(headers)).toEqual(['X-Zz-Tenant']);
    const value = headers['X-Zz-Tenant'];
    expect(value).toBeInstanceOf(Secret);
    expect((value as Secret).reveal()).toBe('zz_test_tenant');
    // Sans en-têtes : aucun champ ; en-têtes illisibles ou malformés : refus explicite (jamais un run sans eux).
    expect((await llmConfigFromSettings(SETTINGS, read, ['extract'])).providers[0]).not.toHaveProperty('headers');
    await expect(llmConfigFromSettings(withHeaders, read, ['extract'])).rejects.toThrow(/en-têtes illisibles/);
    const malformed = async (id: string): Promise<Secret> => (id === 'sec-h' ? new Secret('["pas un objet"]') : read(id));
    await expect(llmConfigFromSettings(withHeaders, malformed, ['extract'])).rejects.toThrow(LlmSettingsError);
  });

  it('clé illisible, fournisseur inconnu ou réglages absents : refus explicite', async () => {
    await expect(llmConfigFromSettings(SETTINGS, read, ['repair'])).rejects.toThrow(LlmSettingsError);
    await expect(llmConfigFromSettings({ ...SETTINGS, roles: { extract: { provider: 'nope', model: 'x' } } }, read, ['extract'])).rejects.toThrow(/inconnu/);
    await expect(llmConfigFromSettings(null, read)).rejects.toThrow(LlmSettingsError);
  });
});

describe('prix invalide (revue fix-ux-11, point 10)', () => {
  const modelWith = async (price: unknown) => {
    const settings = { ...SETTINGS, providers: [{ ...SETTINGS.providers[0]!, models: { 'glm-5.3': { price } } }] };
    return (await llmConfigFromSettings(settings, read, ['extract'])).providers[0]?.models[0] as { price?: unknown };
  };
  it('un prix négatif, infini ou NaN est un prix absent, jamais 0', async () => {
    for (const price of [{ in: -1, out: 2 }, { in: 1, out: -2 }, { in: 1, out: 2, in_cached: -0.1 }, { in: 1, out: 2, in_cache_write: -3 }, { in: Infinity, out: 2 }, { in: 1, out: Number.NaN }]) {
      expect((await modelWith(price)).price).toBeUndefined();
    }
  });
  it('un prix à 0 reste un prix valide (modèle local gratuit)', async () => {
    expect((await modelWith({ in: 0, out: 0 })).price).toEqual({ in: 0, out: 0 });
  });
});
