// SPDX-License-Identifier: MIT
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { SDK_COMPATIBILITY, type CreateSessionRequest } from './index.js';

describe('@sym-browser/sdk (squelette)', () => {
  test('compatibilité : API v1, Playwright 1.63.0', () => {
    expect(SDK_COMPATIBILITY).toEqual({ api: '1', protocol: expect.stringMatching(/^\d+\.\d+\.\d+$/) as string, playwright: '1.63.0' });
  });

  test('types du contrat ré-exportés (contrôle à la compilation)', () => {
    const request: CreateSessionRequest = { type: 'shared', egress: { allowedHosts: ['example.com'] } };
    expect(request.type).toBe('shared');
  });

  test('licence MIT, dépendance de production limitée au contrat MIT', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { license: string; dependencies: Record<string, string> };
    expect(manifest.license).toBe('MIT');
    expect(Object.keys(manifest.dependencies)).toEqual(['@sym/contracts']);
  });
});
