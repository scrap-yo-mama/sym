// SPDX-License-Identifier: MIT
import { expect, test } from 'vitest';
import { createApiClient } from './index.js';

test('le client typé appelle /api/health avec le cookie de même origine', async () => {
  let seen: Request | undefined;
  const fake = async (request: Request) => {
    seen = request;
    return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = createApiClient({ baseUrl: 'http://x.test', fetch: fake });
  const { data, error } = await client.GET('/api/health');
  expect(error).toBeUndefined();
  expect(data).toEqual({ status: 'ok' });
  expect(seen?.url).toBe('http://x.test/api/health');
  expect(seen?.credentials).toBe('same-origin');
});

test('une erreur 401 de /api/me est exposée dans `error`, sans exception', async () => {
  const fake = async () =>
    new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'x' } }), { status: 401, headers: { 'content-type': 'application/json' } });
  const { data, error, response } = await createApiClient({ baseUrl: 'http://x.test', fetch: fake }).GET('/api/me');
  expect(data).toBeUndefined();
  expect(error?.error.code).toBe('unauthorized');
  expect(response.status).toBe(401);
});
