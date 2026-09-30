import { expect, test } from 'vitest';
import { buildServer } from './app.js';

test('GET /api/health répond 200 {status:"ok"}', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/api/health' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok' });
  await app.close();
});
