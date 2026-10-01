// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.1 (14 § 2, § 13) : le catalogue des variables est la SOURCE UNIQUE de la référence publiée et de `.env.example`
// (assert_env_docs_in_sync), le code ne lit aucune variable que le catalogue ignore, `MASTER_KEY_FILE` est lue, une clé de
// 31 octets ou une phrase est refusée avec la commande `keygen`, une variable inconnue préfixée RUNTIME_ ou MASTER_ est signalée.
import { generateMasterKey, ENV_CATALOG, envVariableNames, loadKeyring, MasterKeyError, renderEnvExample, renderEnvReference, unknownReservedVariables, unknownReservedVariablesWarning } from '@runtime/core';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConfigError, loadServerConfig } from '../apps/server/src/config.js';
import { loadWorkerConfig } from '../apps/worker/src/config.js';
import { main as startWorkerProcess } from '../apps/worker/src/main.js';

const runtimeDir = new URL('..', import.meta.url).pathname;
const read = (path: string) => readFileSync(join(runtimeDir, path), 'utf8');

const SKIP = new Set(['node_modules', 'dist', 'coverage', '.wxt', 'test-results', 'blob-report']);
/** Sources de production : ni tests, ni bancs de test (`*.testkit.ts`), ni déclarations. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.ts$/.test(entry.name) && !/\.(test|testkit|d)\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}
const productionSources = ['apps/server/src', 'apps/worker/src', 'apps/cli/src', 'packages/core/src', 'packages/db/src', 'packages/llm/src'].flatMap((d) => sourceFiles(join(runtimeDir, d)));

/** Noms de variables lus par le code : `env['X']`, `env.X`, `helper(env, 'X'`. */
function variablesReadByCode(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of productionSources) {
    const text = readFileSync(file, 'utf8');
    for (const re of [/\benv\[\s*['"`]([A-Z][A-Z0-9_]+)['"`]\s*\]/g, /\benv\.([A-Z][A-Z0-9_]+)/g, /\(\s*env\s*,\s*['"`]([A-Z][A-Z0-9_]+)['"`]/g]) {
      for (const match of text.matchAll(re)) {
        const name = match[1]!;
        (found.get(name) ?? found.set(name, new Set()).get(name)!).add(file.replace(runtimeDir, ''));
      }
    }
  }
  return found;
}

describe('assert_env_docs_in_sync : le catalogue est la source unique (14 § 2)', () => {
  test('docs/variables-env.md et .env.example sont EXACTEMENT ce que le catalogue génère', () => {
    expect(read('docs/variables-env.md')).toBe(renderEnvReference());
    expect(read('.env.example')).toBe(renderEnvExample());
  });

  test('toute variable lue par le code de production figure au catalogue (pas de variable non documentée)', () => {
    const known = envVariableNames();
    const undocumented = [...variablesReadByCode()].filter(([name]) => !known.has(name)).map(([name, files]) => `${name} (${[...files].join(', ')})`);
    expect(undocumented).toEqual([]);
  });

  test('toute variable du catalogue est lue quelque part (pas de variable fantôme), image comprise', () => {
    const corpus = [...productionSources.map((f) => readFileSync(f, 'utf8')), read('deploy/Dockerfile'), read('deploy/entrypoint.sh')].join('\n');
    const ghosts = ENV_CATALOG.map((v) => v.name).filter((name) => !corpus.includes(name));
    expect(ghosts).toEqual([]);
  });

  test('noms uniques, une description par variable, `_FILE` seulement pour les secrets annoncés', () => {
    const names = ENV_CATALOG.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const variable of ENV_CATALOG) {
      expect(variable.description.length, variable.name).toBeGreaterThan(10);
      if (variable.file) expect(variable.secret, `${variable.name} accepte _FILE sans être un secret`).toBe(true);
    }
    expect(ENV_CATALOG.filter((v) => v.file).map((v) => v.name).sort()).toEqual(['ADMIN_BOOTSTRAP_TOKEN', 'MASTER_KEY', 'MASTER_KEY_PREVIOUS', 'METRICS_TOKEN']);
  });

  test('.env.example ne contient que des valeurs qui FONT ÉCHOUER le démarrage (aucune ne sert d’exemple utilisable)', () => {
    const example = Object.fromEntries(
      read('.env.example')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    expect(Object.keys(example).sort()).toEqual(['ADMIN_BOOTSTRAP_TOKEN', 'DATABASE_URL', 'MASTER_KEY', 'PUBLIC_URL']);
    const env = { ...example, ADMIN_BOOTSTRAP_TOKEN: undefined } as NodeJS.ProcessEnv;
    expect(() => loadServerConfig({ ...(example as NodeJS.ProcessEnv) })).toThrow(ConfigError);
    expect(() => loadWorkerConfig({ ...env })).toThrow();
    // Le jeton d'exemple seul (les trois autres valeurs corrigées) reste refusé : trop court.
    expect(() => loadServerConfig({ DATABASE_URL: 'postgres://u@h/db', PUBLIC_URL: 'https://x.example', MASTER_KEY: generateMasterKey(), ADMIN_BOOTSTRAP_TOKEN: example['ADMIN_BOOTSTRAP_TOKEN'] })).toThrow(/trop court/);
  });
});

describe('suffixe _FILE et refus de clé invalide (14 § 2, § 13)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const fileWith = (content: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'zz_test_envfile-'));
    dirs.push(dir);
    const path = join(dir, 'secret');
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  };

  test('MASTER_KEY_FILE : la clé est lue (blancs finaux retirés) ; MASTER_KEY et MASTER_KEY_FILE ensemble : refus', () => {
    const key = generateMasterKey();
    const keyring = loadKeyring({ MASTER_KEY_FILE: fileWith(`${key}\n`) });
    expect(keyring.current.exportBase64()).toBe(key);
    expect(() => loadKeyring({ MASTER_KEY: key, MASTER_KEY_FILE: fileWith(key) })).toThrow(/toutes les deux/);
  });

  test('MASTER_KEY de 31 octets, ou phrase secrète : refusée, le message nomme `runtime keygen`', () => {
    const thirtyOne = Buffer.alloc(31, 7).toString('base64');
    for (const bad of [thirtyOne, 'correct horse battery staple', '']) {
      expect(() => loadKeyring({ MASTER_KEY: bad }), bad).toThrow(MasterKeyError);
      expect(() => loadKeyring({ MASTER_KEY: bad }), bad).toThrow(/runtime keygen/);
    }
    expect(() => loadKeyring({})).toThrow(/runtime keygen/);
  });

  test('ADMIN_BOOTSTRAP_TOKEN_FILE et METRICS_TOKEN_FILE : lues par le serveur ; les deux formes ensemble : refus', () => {
    const base = { DATABASE_URL: 'postgres://u@h/db', PUBLIC_URL: 'https://x.example', MASTER_KEY: generateMasterKey() };
    const token = 'zz_test_' + 'a'.repeat(40);
    const config = loadServerConfig({ ...base, ADMIN_BOOTSTRAP_TOKEN_FILE: fileWith(`${token}\n`), METRICS_TOKEN_FILE: fileWith(`${token}b\n`) });
    expect(config.bootstrapToken?.reveal()).toBe(token);
    expect(config.metricsToken?.reveal()).toBe(`${token}b`);
    expect(() => loadServerConfig({ ...base, ADMIN_BOOTSTRAP_TOKEN: token, ADMIN_BOOTSTRAP_TOKEN_FILE: fileWith(token) })).toThrow(/toutes les deux/);
  });

  test('une variable obligatoire manquante nomme la variable et la commande de génération', () => {
    expect(() => loadServerConfig({ DATABASE_URL: 'postgres://u@h/db', PUBLIC_URL: 'https://x.example' })).toThrow(/MASTER_KEY.*runtime keygen/);
    expect(() => loadServerConfig({ PUBLIC_URL: 'https://x.example', MASTER_KEY: generateMasterKey() })).toThrow(/DATABASE_URL/);
    expect(() => loadServerConfig({ DATABASE_URL: 'postgres://u@h/db', MASTER_KEY: generateMasterKey() })).toThrow(/PUBLIC_URL/);
  });
});

describe('variable inconnue préfixée RUNTIME_ ou MASTER_ : signalée, jamais fatale (14 § 2)', () => {
  test('unknownReservedVariables : ne retient que les préfixes réservés absents du catalogue, valeurs ignorées', () => {
    expect(unknownReservedVariables({ RUNTIME_MODE: 'all', RUNTIME_VERSION: '1.0.0', MASTER_KEY: 'x', MASTER_KEY_FILE: '/x', MASTER_KEY_PREVIOUS_FILE: '/y' })).toEqual([]);
    expect(unknownReservedVariables({ MASTER_KEY_PRIVIOUS: 'secret-value', RUNTIME_MODEE: 'server', PATH: '/bin', DATABASE_URLL: 'x' })).toEqual(['MASTER_KEY_PRIVIOUS', 'RUNTIME_MODEE']);
    const warning = unknownReservedVariablesWarning({ MASTER_KEY_PRIVIOUS: 'secret-value' });
    expect(warning).toMatch(/MASTER_KEY_PRIVIOUS/);
    expect(warning).not.toMatch(/secret-value/);
    expect(unknownReservedVariablesWarning({ PATH: '/bin' })).toBeNull();
  });

  test('server et worker avertissent au démarrage (nom seulement) et ne s’arrêtent pas pour cela', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitCode = process.exitCode;
    try {
      const base = { DATABASE_URL: 'postgres://u@127.0.0.1:1/db', PUBLIC_URL: 'https://x.example', MASTER_KEY: generateMasterKey(), RUNTIME_MODEE: 'sekret-typo' };
      expect(() => loadServerConfig({ ...base })).not.toThrow();
      // Le worker : main() prévient AVANT de charger la configuration ; la base injoignable le fait ensuite refuser (code 2).
      expect(await startWorkerProcess({ ...base })).toBeNull();
      const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output.match(/RUNTIME_MODEE/g)?.length).toBeGreaterThanOrEqual(2);
      expect(output).toMatch(/Refus de démarrer le worker/);
      expect(output).not.toContain('sekret-typo');
    } finally {
      spy.mockRestore();
      process.exitCode = exitCode;
    }
  }, 30_000);
});
