// SPDX-License-Identifier: AGPL-3.0-only
// Jeu fermé de messages popup → service worker : tout autre message est refusé.
import { describe, expect, test } from 'vitest';
import { parseRequest } from './messages.ts';

describe('messages', () => {
  test('jeu fermé : seuls les messages connus et bien formés passent', () => {
    expect(parseRequest({ type: 'status' })).toEqual({ type: 'status' });
    expect(parseRequest({ type: 'connectSite', domain: 'zz-test.example', mode: 'server' })).toEqual({ type: 'connectSite', domain: 'zz-test.example', mode: 'server' });
    expect(parseRequest({ type: 'pair', instanceUrl: 'https://x.example', code: 'ABCDE-FGHJK', deviceLabel: null })).not.toBeNull();
    for (const bad of [null, 'status', {}, { type: 'eval', code: '1' }, { type: 'connectSite', domain: 'x', mode: 'all' }, { type: 'pair', instanceUrl: 1, code: 'x', deviceLabel: null }, { type: 'readCookies', domain: 'x' }]) {
      expect(parseRequest(bad)).toBeNull();
    }
  });
});
