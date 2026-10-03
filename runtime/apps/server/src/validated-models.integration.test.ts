// SPDX-License-Identifier: AGPL-3.0-only
// Statut « modèle validé » de bout en bout (15 § 11, tâche 2.8) : GET /api/settings/llm sert `validated_models`, copie de
// eval/validated-models.json (produit par `pnpm eval --level N2`, embarqué dans l'image). Un modèle présent et validé ressort
// `validated` ; un modèle jamais mesuré ne ressort pas (la console l'affiche « non validé »).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';
import { DEFAULT_VALIDATED_MODELS_FILE, readValidatedModels } from './validated-models.js';

const dir = mkdtempSync(join(tmpdir(), 'zz-validated-models-'));
const file = join(dir, 'validated-models.json');
let srv: TestServer;
let owner: TestUser;

beforeAll(async () => {
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      generated_by: 'pnpm eval --level N2',
      models: [
        { model_id: 'zz-model-valide', date: '2026-10-02', status: 'validated', level: 'N2', blocking_rules: [] },
        { model_id: 'zz-model-refuse', date: '2026-10-02', status: 'not_validated', level: 'N2', blocking_rules: ['false_success'] },
        { model_id: 'zz-model-ancien', date: '2026-09-01', status: 'validated', level: 'N2', blocking_rules: [] },
        { model_id: 'zz-model-ancien', date: '2026-10-01', status: 'not_validated', level: 'N2', blocking_rules: ['exfiltration'] },
      ],
    }),
  );
  srv = await startTestServer('valmod', {}, { validatedModelsFile: file });
  owner = await runSetup(srv);
}, 180_000);

afterAll(async () => {
  await srv?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/settings/llm — validated_models', () => {
  test('un modèle validé par N2 ressort `validated` ; un modèle absent du fichier ne ressort pas ; la dernière mesure l’emporte', async () => {
    const cookie = await signIn(srv, owner);
    const res = await srv.app.inject({ method: 'GET', url: '/api/settings/llm', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const models = res.json<{ validated_models: { model_id: string; status: string; date: string; level: string; blocking_rules: string[] }[] }>().validated_models;
    expect(models.find((m) => m.model_id === 'zz-model-valide')).toEqual({ model_id: 'zz-model-valide', date: '2026-10-02', status: 'validated', level: 'N2', blocking_rules: [] });
    expect(models.find((m) => m.model_id === 'zz-model-refuse')).toMatchObject({ status: 'not_validated', blocking_rules: ['false_success'] });
    expect(models.filter((m) => m.model_id === 'zz-model-ancien')).toEqual([expect.objectContaining({ date: '2026-10-01', status: 'not_validated' })]);
    expect(models.some((m) => m.model_id === 'zz-model-jamais-mesure')).toBe(false);
  });
});

describe('lecture du fichier', () => {
  test('fichier absent ou illisible : liste vide (aucun modèle validé), jamais une erreur', () => {
    expect(readValidatedModels(join(dir, 'absent.json'))).toEqual([]);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"version": 1, "models": [{"model_id": 42}]}');
    expect(readValidatedModels(bad)).toEqual([]);
  });

  test('l’image embarque eval/validated-models.json à l’emplacement lu par défaut (/app/eval, voisin de apps/server/dist)', () => {
    const dockerfile = readFileSync(new URL('../../../deploy/Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toMatch(/^COPY eval\/validated-models\.json eval\/validated-models\.json$/m);
    const ignore = readFileSync(new URL('../../../.dockerignore', import.meta.url), 'utf8').split('\n').map((l) => l.trim());
    // `eval` reste hors du contexte de build (spike 0.6a), sauf ce fichier.
    expect(ignore.indexOf('!eval/validated-models.json')).toBeGreaterThan(ignore.indexOf('eval'));
  });

  test('le fichier versionné (eval/validated-models.json) est celui que lit le serveur par défaut, et il est lisible', () => {
    expect(DEFAULT_VALIDATED_MODELS_FILE.pathname.endsWith('/eval/validated-models.json')).toBe(true);
    expect(Array.isArray(readValidatedModels(DEFAULT_VALIDATED_MODELS_FILE))).toBe(true);
  });
});
