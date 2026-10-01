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

  it('clé illisible, fournisseur inconnu ou réglages absents : refus explicite', async () => {
    await expect(llmConfigFromSettings(SETTINGS, read, ['repair'])).rejects.toThrow(LlmSettingsError);
    await expect(llmConfigFromSettings({ ...SETTINGS, roles: { extract: { provider: 'nope', model: 'x' } } }, read, ['extract'])).rejects.toThrow(/inconnu/);
    await expect(llmConfigFromSettings(null, read)).rejects.toThrow(LlmSettingsError);
  });
});
