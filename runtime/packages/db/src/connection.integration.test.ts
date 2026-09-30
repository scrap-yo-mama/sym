// DATABASE_URL_DIRECT sur base réelle : la sonde LISTEN/NOTIFY passe sur une connexion directe ; un pooler
// transactionnel (simulé par la sonde ou détecté par l'heuristique) sans URL directe fait refuser le démarrage.
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { createTestDatabase, withClient, type TestDatabase } from '../../../tests/helpers/pg.js';
import { probeSessionSupport, resolveConnections } from './connection.js';

let tdb: TestDatabase;

beforeAll(async () => {
  tdb = await createTestDatabase('conn');
});
afterAll(async () => {
  await tdb.drop();
});

describe(`connexions sur PostgreSQL ${inject('pgVersion')}`, () => {
  test('le serveur est bien de la version de la matrice', async () => {
    const { rows } = await withClient(tdb.url, (c) => c.query<{ v: string }>("SELECT current_setting('server_version_num') AS v"));
    expect(Math.floor(Number(rows[0]?.v) / 10000)).toBe(Number(inject('pgVersion')));
  });

  test('connexion directe : pg_backend_pid stable et NOTIFY reçu', async () => {
    expect(await probeSessionSupport(tdb.url)).toEqual({ ok: true });
  });

  test('DATABASE_URL seule, directe : acceptée', async () => {
    expect(await resolveConnections({ DATABASE_URL: tdb.url })).toEqual({ appUrl: tdb.url, sessionUrl: tdb.url });
  });

  test('pooler transactionnel + DATABASE_URL_DIRECT réelle : session sur l’URL directe', async () => {
    const pooled = 'postgres://u:p@db.example-pooler.test:6543/app';
    expect(await resolveConnections({ DATABASE_URL: pooled, DATABASE_URL_DIRECT: tdb.url })).toEqual({
      appUrl: pooled,
      sessionUrl: tdb.url,
    });
  });

  test('pooler transactionnel non reconnaissable (sonde en échec) sans URL directe : refus clair', async () => {
    const pooler = () => Promise.resolve({ ok: false as const, reason: 'NOTIFY non reçu en 3000 ms (LISTEN inopérant)' });
    await expect(resolveConnections({ DATABASE_URL: tdb.url }, pooler)).rejects.toThrow(
      /connexion de session requise : DATABASE_URL .* définissez DATABASE_URL_DIRECT/,
    );
  });
});
