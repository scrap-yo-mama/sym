// SPDX-License-Identifier: AGPL-3.0-only
import { generateMasterKey } from '@runtime/core';
import { afterEach, expect, test } from 'vitest';
import { ConfigError, loadServerConfig, PUBLISHED_EXTENSION_IDS, TELEMETRY_VARIABLES } from './config.js';

const base = () => ({ DATABASE_URL: 'postgres://u@localhost/db', PUBLIC_URL: 'https://runtime.zz-test.example/', MASTER_KEY: generateMasterKey() });

afterEach(() => {
  for (const name of TELEMETRY_VARIABLES) delete process.env[name];
});

test('variables de télémétrie de Better Auth retirées de env ET de process.env (INV9)', () => {
  process.env['BETTER_AUTH_TELEMETRY'] = '1';
  const env: NodeJS.ProcessEnv = { ...base(), BETTER_AUTH_TELEMETRY_ENDPOINT: 'https://zz-test.invalid' };
  loadServerConfig(env);
  expect(TELEMETRY_VARIABLES.filter((n) => env[n] !== undefined || process.env[n] !== undefined)).toEqual([]);
});

test('jeton d’amorçage : lu puis retiré de l’environnement, longueur minimale, masqué', () => {
  const token = 'zz_test_' + 'k'.repeat(40);
  const env: NodeJS.ProcessEnv = { ...base(), ADMIN_BOOTSTRAP_TOKEN: token };
  const config = loadServerConfig(env);
  expect(config.bootstrapToken?.reveal()).toBe(token);
  expect(JSON.stringify(config)).not.toContain(token);
  expect(env['ADMIN_BOOTSTRAP_TOKEN']).toBeUndefined();
  expect(env['MASTER_KEY']).toBeUndefined();
  expect(config.publicUrl).toBe('https://runtime.zz-test.example');
  expect(() => loadServerConfig({ ...base(), ADMIN_BOOTSTRAP_TOKEN: 'court' })).toThrow(ConfigError);
  expect(loadServerConfig(base()).bootstrapToken).toBeNull();
});

test('PUBLIC_URL et DATABASE_URL obligatoires', () => {
  expect(() => loadServerConfig({ ...base(), PUBLIC_URL: '' })).toThrow(/PUBLIC_URL/);
  expect(() => loadServerConfig({ ...base(), DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
});

test('TRUST_PROXY : faux par défaut (IP de la connexion), sauts, liste d’IP/CIDR ; valeur invalide refusée', () => {
  expect(loadServerConfig(base()).trustProxy).toBe(false);
  expect(loadServerConfig({ ...base(), TRUST_PROXY: '1' }).trustProxy).toBe(1);
  expect(loadServerConfig({ ...base(), TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).trustProxy).toBe('10.0.0.0/8, 127.0.0.1');
  expect(() => loadServerConfig({ ...base(), TRUST_PROXY: 'n’importe quoi' })).toThrow(/TRUST_PROXY/);
});

test('correctif 17 : origine du tunnel fermée par défaut (identifiants publiés seulement) ; toute extension en mode développement explicite', () => {
  const closed = loadServerConfig(base()).tunnel.extensionOrigins;
  expect(closed).toEqual({ ids: [...PUBLISHED_EXTENSION_IDS], allowAny: false });
  expect(loadServerConfig({ ...base(), TUNNEL_EXTENSION_IDS: 'abcdefghijklmnopabcdefghijklmnop' }).tunnel.extensionOrigins).toEqual({ ids: ['abcdefghijklmnopabcdefghijklmnop'], allowAny: false });
  expect(loadServerConfig({ ...base(), TUNNEL_ALLOW_ANY_EXTENSION: 'true' }).tunnel.extensionOrigins).toEqual({ ids: [...PUBLISHED_EXTENSION_IDS], allowAny: true });
  expect(() => loadServerConfig({ ...base(), TUNNEL_ALLOW_ANY_EXTENSION: 'oui' })).toThrow(/TUNNEL_ALLOW_ANY_EXTENSION/);
});

test('MCP : origines admises comparées en entier (schéma, hôte, port) ; MCP_ALLOWED_ORIGINS mêle origines complètes et noms d’hôte', () => {
  const own = loadServerConfig(base()).mcp;
  expect(own.allowedOrigins).toEqual(['https://runtime.zz-test.example']);
  expect(own.allowedOriginHosts).toEqual([]);
  const mixed = loadServerConfig({ ...base(), MCP_ALLOWED_ORIGINS: 'https://claude.zz-test.example:8443, 127.0.0.1,HTTP://LOCALHOST:3100' }).mcp;
  expect(mixed.allowedOrigins).toEqual(['https://runtime.zz-test.example', 'https://claude.zz-test.example:8443', 'http://localhost:3100']);
  expect(mixed.allowedOriginHosts).toEqual(['127.0.0.1']);
  for (const bad of ['https://claude.zz-test.example/path', 'ftp://claude.zz-test.example', 'claude.zz-test.example:8443', 'https://u:p@claude.zz-test.example']) {
    expect(() => loadServerConfig({ ...base(), MCP_ALLOWED_ORIGINS: bad }), bad).toThrow(/MCP_ALLOWED_ORIGINS/);
  }
});
