import { expect, test } from 'vitest';
import { run } from './cli.js';

test('--version affiche la version', async () => {
  expect(await run(['--version'])).toEqual({ code: 0, out: '0.0.0' });
});

test('commande inconnue : code 1', async () => {
  expect((await run(['nope'])).code).toBe(1);
});

test('migrate sans DATABASE_URL : refus nommant la variable', async () => {
  const res = await run(['migrate'], { env: {} });
  expect(res.code).toBe(2);
  expect(res.out).toMatch(/Refus de démarrer.*DATABASE_URL manquante/);
});

test('migrate derrière un pooler transactionnel sans URL directe : refus clair, sans connexion', async () => {
  const res = await run(['migrate'], {
    env: { DATABASE_URL: 'postgres://u:secret@aws-0-eu-west-3.pooler.supabase.com:6543/postgres' },
    probe: () => Promise.reject(new Error('la sonde ne doit pas être appelée')),
  });
  expect(res.code).toBe(2);
  expect(res.out).toContain('connexion de session requise');
  expect(res.out).toContain('DATABASE_URL_DIRECT');
  expect(res.out).not.toContain('secret');
});

test('migrate down refusé en production', async () => {
  const res = await run(['migrate', 'down'], {
    env: { NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db.example:5432/x' },
    probe: () => Promise.resolve({ ok: true }),
  });
  expect(res.code).toBe(2);
  expect(res.out).toContain('refusé en production');
});
