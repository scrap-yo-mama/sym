// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { SDK_COMPATIBILITY, SymBrowser, SymBrowserError, type CreateSessionRequest } from './index.js';

describe('@sym-browser/sdk', () => {
  test('compatibilité : API v1, Playwright 1.63.0', () => {
    expect(SDK_COMPATIBILITY).toEqual({ api: '1', protocol: expect.stringMatching(/^\d+\.\d+\.\d+$/) as string, playwright: '1.63.0' });
  });

  test('types du contrat ré-exportés (contrôle à la compilation)', () => {
    const request: CreateSessionRequest = { type: 'shared', egress: { allowedHosts: ['example.com'] } };
    expect(request.type).toBe('shared');
  });

  test('API publique : SymBrowser et SymBrowserError', () => {
    expect(typeof SymBrowser).toBe('function');
    expect(new SymBrowserError({ code: 'no_node', status: 503, message: 'x' })).toBeInstanceOf(Error);
  });

  test('licence MIT ; dépendances de production : le contrat MIT et playwright-core (Apache-2.0) seulement', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { license: string; dependencies: Record<string, string> };
    expect(manifest.license).toBe('MIT');
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['@sym/contracts', 'playwright-core']);
    expect(manifest.dependencies['playwright-core']).toBe('catalog:');
  });
});
