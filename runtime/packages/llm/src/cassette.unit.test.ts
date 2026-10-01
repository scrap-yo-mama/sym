// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { cassetteMode, createCassetteKit, providerFixture, requestKey, requestShape, scrub, secretValuesFromEnv, type CassetteFile } from './cassette.testkit.js';
import { createFakeProvider, scripted } from './fake-provider.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'zz_test_cassette-'));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const body = (prompt: string, model = 'm') => JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false });
const post = (url: string, payload: string) => fetch(`${url}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer zz-secret-key-1234' }, body: payload });

function writeCassette(dir: string, name: string, entries: CassetteFile['entries']): void {
  mkdirSync(join(dir, 'p'), { recursive: true });
  const data: CassetteFile = { version: 1, provider: 'p', case: name, synthetic: false, entries };
  writeFileSync(join(dir, 'p', `${name}.json`), JSON.stringify(data));
}

describe('clé de correspondance normalisée', () => {
  test('ne dépend pas du texte du prompt, dépend de la structure', () => {
    const shape = (prompt: string, model = 'm') => requestShape(JSON.parse(body(prompt, model)) as Record<string, unknown>);
    expect(requestKey('POST', '/x', shape('bonjour'))).toBe(requestKey('POST', '/x', shape('un tout autre prompt avec jean@example.org')));
    expect(requestKey('POST', '/x', shape('a'))).not.toBe(requestKey('POST', '/x', shape('a', 'autre-modele')));
    expect(JSON.stringify(shape('secret-prompt-text'))).not.toContain('secret-prompt-text');
  });

  test('mode : replay par défaut, record seulement si LLM_CASSETTE_MODE=record exactement', () => {
    expect(cassetteMode({})).toBe('replay');
    expect(cassetteMode({ LLM_CASSETTE_MODE: 'true' })).toBe('replay');
    expect(cassetteMode({ LLM_CASSETTE_MODE: 'record' })).toBe('record');
    expect(() => providerFixture('deepinfra', { LLM_CASSETTE_MODE: 'record' })).toThrow(/DEEPINFRA_API_KEY absente/);
    expect(providerFixture('deepinfra', {}).apiKey.reveal()).toBe('replay-placeholder-not-a-key');
  });

  test('fournisseur anthropic (D-42) : URL, clé, modèle et purge des secrets', () => {
    const replay = providerFixture('anthropic', {});
    expect(replay.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(replay.model).toBe('claude-opus-4-8');
    expect(replay.apiKey.reveal()).toBe('replay-placeholder-not-a-key');
    expect(providerFixture('anthropic', { LLM_TEST_MODEL: 'claude-x' }).model).toBe('claude-opus-4-8'); // rejeu : jamais l'environnement
    expect(() => providerFixture('anthropic', { LLM_CASSETTE_MODE: 'record' })).toThrow(/ANTHROPIC_API_KEY absente/);
    const rec = providerFixture('anthropic', { LLM_CASSETTE_MODE: 'record', ANTHROPIC_API_KEY: 'zz-anthropic-key-1234', ANTHROPIC_BASE_URL: 'https://proxy.test/v1', LLM_TEST_MODEL: 'claude-x' });
    expect(rec.baseUrl).toBe('https://proxy.test/v1');
    expect(rec.model).toBe('claude-x');
    expect(rec.apiKey.reveal()).toBe('zz-anthropic-key-1234');
    expect(secretValuesFromEnv({ ANTHROPIC_API_KEY: 'zz-anthropic-key-1234' })).toEqual(['zz-anthropic-key-1234']);
  });

  test('scrub : retire les valeurs de clé ; en mode strict, refuse d\'enregistrer', () => {
    expect(scrub('a zz-secret-key-1234 b', ['zz-secret-key-1234'])).toBe('a [REDACTED] b');
    expect(() => scrub('a zz-secret-key-1234 b', ['zz-secret-key-1234'], true)).toThrow(/annulé/);
    expect(scrub('rien', ['zz-secret-key-1234'], true)).toBe('rien');
  });
});

describe('replay strict', () => {
  const dir = tmp();
  const kit = createCassetteKit(dir, {});
  beforeAll(() => kit.start());
  afterAll(() => kit.stop());
  afterEach(() => {
    kit.finish();
  });

  const entryFor = (prompt: string, text: string) => {
    const shape = requestShape(JSON.parse(body(prompt)) as Record<string, unknown>);
    return { key: requestKey('POST', '/v1/chat/completions', shape), request: { method: 'POST', path: '/v1/chat/completions', shape }, response: { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) } };
  };

  test('rejoue les occurrences dans l\'ordre ; le prompt brut n\'intervient pas', async () => {
    writeCassette(dir, 'ok', [entryFor('x', 'un'), entryFor('x', 'deux')]);
    kit.use('p', 'ok');
    const one = await post('https://replay.test/v1', body('premier prompt'));
    const two = await post('https://replay.test/v1', body('deuxième prompt'));
    expect(await one.json()).toEqual({ text: 'un' });
    expect(await two.json()).toEqual({ text: 'deux' });
  });

  test('requête inconnue : 599 et échec de finish()', async () => {
    writeCassette(dir, 'unknown', [entryFor('x', 'un')]);
    kit.use('p', 'unknown');
    const res = await post('https://replay.test/v1', body('x', 'modele-inconnu'));
    expect(res.status).toBe(599);
    expect(() => kit.finish()).toThrow(/inconnue/);
  });

  test('entrée non rejouée : échec de finish()', () => {
    writeCassette(dir, 'unused', [entryFor('x', 'un')]);
    kit.use('p', 'unused');
    expect(() => kit.finish()).toThrow(/non rejouée/);
  });

  test('cassette absente : échec explicite, pas de réseau', () => {
    expect(() => kit.use('p', 'absente')).toThrow(/cassette absente/);
  });
});

describe('record (contre le faux fournisseur, sans réseau externe)', () => {
  test('enregistre sans en-têtes sensibles ni clé, puis rejoue à l\'identique', async () => {
    const dir = tmp();
    const fake = await createFakeProvider({ scenarios: { m: [scripted.json({ ok: 1 }), scripted.error(429, undefined, { 'retry-after': '1' })] } });
    const secret = 'zz-secret-key-1234';
    const recorder = createCassetteKit(dir, { LLM_CASSETTE_MODE: 'record', DEEPINFRA_API_KEY: secret });
    recorder.start();
    try {
      recorder.use('p', 'rec');
      const a = await post(fake.baseUrl, body('hello'));
      const b = await post(fake.baseUrl, body('hello'));
      expect(a.status).toBe(200);
      expect(b.status).toBe(429);
      recorder.finish();
    } finally {
      recorder.stop();
      await fake.close();
    }
    const text = readFileSync(join(dir, 'p', 'rec.json'), 'utf8');
    expect(text).not.toContain(secret);
    expect(text).not.toMatch(/authorization|bearer/i);
    expect(text).not.toContain('hello');
    const saved = JSON.parse(text) as CassetteFile;
    expect(saved.entries).toHaveLength(2);
    expect(saved.entries[1]?.response.headers['retry-after']).toBe('1');

    const replayer = createCassetteKit(dir, {});
    replayer.start();
    try {
      replayer.use('p', 'rec');
      expect((await post('http://127.0.0.1:1/v1', body('autre prompt'))).status).toBe(200);
      expect((await post('http://127.0.0.1:1/v1', body('encore un autre'))).status).toBe(429);
      replayer.finish();
    } finally {
      replayer.stop();
    }
  });

  test('refuse d\'enregistrer si une valeur de clé figure dans la réponse', async () => {
    const dir = tmp();
    const secret = 'zz-secret-key-9999';
    const fake = await createFakeProvider({ scenarios: { m: [scripted.text(`echo ${secret}`)] } });
    const recorder = createCassetteKit(dir, { LLM_CASSETTE_MODE: 'record', OPENROUTER_API_KEY: secret });
    recorder.start();
    try {
      recorder.use('p', 'leak');
      const res = await post(fake.baseUrl, body('hello'));
      expect(res.status).toBe(500); // l'enregistrement est annulé : rien n'est rendu ni écrit
    } finally {
      recorder.stop();
      await fake.close();
    }
  });
});

describe('aucune cassette du dépôt ne contient de secret (D-42)', () => {
  const packages = join(import.meta.dirname, '..', '..');
  const cassettes = readdirSync(packages, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const dir = join(packages, d.name, 'cassettes');
      try {
        return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
      } catch {
        return [];
      }
    });

  test('packages/*/cassettes/ existe et contient des cassettes anthropic', () => {
    expect(cassettes.length).toBeGreaterThan(0);
    expect(cassettes.some((f) => f.includes('/anthropic/'))).toBe(true);
  });

  test.each(cassettes.map((f) => [f.slice(packages.length + 1), f]))('%s : ni sk-ant-, ni Bearer suivi d\'un jeton, ni valeur de clé de l\'environnement', (_name, file) => {
    const text = readFileSync(file as string, 'utf8');
    expect(text).not.toContain('sk-ant-');
    expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/i);
    for (const secret of secretValuesFromEnv()) expect(text.includes(secret)).toBe(false);
  });
});
