// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { createClient } from './index.js';

test('health appelle /api/health', async () => {
  let called = '';
  const fake = (async (url: string) => {
    called = url;
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = createClient('http://x.test/', fake);
  expect(await client.health()).toEqual({ status: 'ok' });
  expect(called).toBe('http://x.test/api/health');
});
