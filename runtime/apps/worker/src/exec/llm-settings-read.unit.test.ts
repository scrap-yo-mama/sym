// SPDX-License-Identifier: AGPL-3.0-only
// U1.12, UX-15 : lecture des réglages IA par le worker. Une lecture qui échoue (clé maîtresse différente, fournisseur
// inconnu, rôle incomplet) n'est PLUS confondue avec « aucun réglage » ni avec « prix manquant » : cause fermée
// `llm_settings_unreadable` et code de raison, sans message libre ni secret (assert_reason_matches_cause).
import { Secret } from '@runtime/core';
import { llmConfigFromSettings, LlmSettingsError, type LlmConfig } from '@runtime/llm';
import { describe, expect, test } from 'vitest';
import { classifyLlmSettingsError, readLlmConfig } from './llm-settings-read.js';

const provider = (extra: Record<string, unknown> = {}) => ({ id: 'anthropic', base_url: 'https://api.zz-test.example/v1', api_key_secret_id: 'sec-1', models: { 'zz-model': { price: { in: 1, out: 2 } } }, ...extra });
const settings = (over: Record<string, unknown> = {}) => ({ providers: [provider()], roles: { investigate: { provider: 'anthropic', model: 'zz-model' } }, ...over });
const readOk = async () => new Secret('zz-key');
const readBroken = async (): Promise<Secret> => {
  throw new Error('bad decrypt: master key mismatch zz-secret-detail');
};

/** Réglages réels passés à `llmConfigFromSettings` : le message d'erreur de la source est classé tel qu'il sort. */
async function failure(value: unknown, read: (id: string) => Promise<Secret>) {
  try {
    await llmConfigFromSettings(value, read, ['investigate']);
  } catch (error) {
    return error;
  }
  throw new Error('aucune erreur');
}

describe('classification des erreurs de lecture des réglages IA (codes fermés)', () => {
  test('clé maîtresse différente : la clé du fournisseur est illisible', async () => {
    expect(classifyLlmSettingsError(await failure(settings(), readBroken))).toBe('key_unreadable');
  });
  test('fournisseur d’un rôle inconnu', async () => {
    expect(classifyLlmSettingsError(await failure(settings({ providers: [] }), readOk))).toBe('provider_unknown');
  });
  test('rôle sans fournisseur ou sans modèle', async () => {
    expect(classifyLlmSettingsError(await failure(settings({ roles: { investigate: { provider: 'anthropic' } } }), readOk))).toBe('role_incomplete');
  });
  test('fournisseur sans adresse ou sans clé', async () => {
    expect(classifyLlmSettingsError(await failure(settings({ providers: [{ id: 'anthropic', models: {} }] }), readOk))).toBe('provider_incomplete');
  });
  test('en-têtes du fournisseur illisibles', async () => {
    expect(classifyLlmSettingsError(await failure(settings({ providers: [provider({ headers_secret_id: 'sec-h' })] }), async (id) => (id === 'sec-h' ? new Secret('{pas du json') : new Secret('k'))))).toBe('headers_unreadable');
  });
  test('réglages absents de la base', async () => {
    expect(classifyLlmSettingsError(await failure(null, readOk))).toBe('settings_missing');
  });
  test('toute autre erreur (base, réseau) : lecture en échec, jamais son message', () => {
    expect(classifyLlmSettingsError(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=zz-secret'))).toBe('settings_read_failed');
    expect(classifyLlmSettingsError(new LlmSettingsError('quelque chose de neuf'))).toBe('settings_invalid');
  });
});

describe('readLlmConfig : trois issues distinctes', () => {
  const config = { providers: [], roles: {} } as unknown as LlmConfig;
  test('réglages lus', async () => {
    expect(await readLlmConfig({ config: async () => config })).toEqual({ kind: 'ok', config });
  });
  test('aucun réglage (rien dans la base, ou aucun port) : config nulle, pas une erreur', async () => {
    expect(await readLlmConfig({ config: async () => null })).toEqual({ kind: 'ok', config: null });
    expect(await readLlmConfig(undefined)).toEqual({ kind: 'ok', config: null });
  });
  test('lecture en échec : cause fermée, sans le message de l’erreur', async () => {
    const out = await readLlmConfig({ config: () => failure(settings(), readBroken).then((e) => Promise.reject(e)) });
    expect(out).toEqual({ kind: 'unreadable', code: 'key_unreadable' });
    expect(JSON.stringify(out)).not.toMatch(/zz-secret-detail/);
  });
});
