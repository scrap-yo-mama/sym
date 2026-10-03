// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.2, critère « contrat OpenAPI validé par tests (Schemathesis en image Docker en CI) ; 0 écart schéma/réponse » (A1).
// La passerelle (base PostgreSQL réelle, nœud simulé) écoute sur 127.0.0.1 ; Schemathesis, en image Docker épinglée par
// empreinte et en réseau hôte, lit /v1/openapi.json et joue des requêtes générées valides et invalides sur chaque opération.
// Vérifications : aucune erreur serveur, statuts déclarés, types de contenu et corps conformes au schéma, données invalides
// refusées (4xx), authentification exigée (401 sans clé). `positive_data_acceptance` est exclue : une requête valide au
// schéma peut être refusée à bon droit par l'état du système (région sans nœud 503, id déjà pris 409).
// Docker Desktop (macOS, Windows) n'expose pas la boucle locale de l'hôte au réseau `host` des conteneurs : Schemathesis y
// joint la passerelle par `host.docker.internal` (redirigé vers la boucle locale de l'hôte), sans réseau `host`.
// Sécurité : seul le conteneur lancé ici est arrêté, par son nom unique (`docker rm -f <nom>`), jamais par pid.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createHarness, type Harness } from '../../test/helpers/harness.js';

/** Schemathesis 4.28.0 (publiée le 2026-09-22, plus de 7 jours), épinglée par empreinte. */
export const SCHEMATHESIS_IMAGE = 'schemathesis/schemathesis:v4.28.0@sha256:0a71757c60ccdba270c154a859d9dd3d019625f782f23ab36ad604771e15f78b';
const CHECKS = [
  'not_a_server_error',
  'status_code_conformance',
  'content_type_conformance',
  'response_schema_conformance',
  'negative_data_rejection',
  'ignored_auth',
].join(',');

/** Statuts 5xx admis : ceux que le contrat déclare (502, 503), voir schemathesis.toml. */
const CONFIG = fileURLToPath(new URL('../../schemathesis.toml', import.meta.url));

/** Docker Desktop : boucle locale de l'hôte joignable par `host.docker.internal` seulement. */
const DOCKER_DESKTOP = /Docker Desktop/i.test(spawnSync('docker', ['info', '--format', '{{.OperatingSystem}}'], { encoding: 'utf8' }).stdout ?? '');

let h: Harness;
let base: string;
beforeAll(async () => {
  h = await createHarness();
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await h?.close();
});

test('Schemathesis (A1) : 0 écart entre l’OpenAPI publiée et les réponses réelles', async () => {
  const name = `symb-schemathesis-${randomBytes(4).toString('hex')}`;
  const target = DOCKER_DESKTOP ? base.replace('127.0.0.1', 'host.docker.internal') : base;
  const args = [
    'run', '--rm', '--name', name, ...(DOCKER_DESKTOP ? [] : ['--network', 'host']), '-v', `${CONFIG}:/config/schemathesis.toml:ro`, SCHEMATHESIS_IMAGE,
    '--config-file', '/config/schemathesis.toml',
    'run', `${target}/v1/openapi.json`,
    '--url', `${target}/v1`,
    '--header', `Authorization: Bearer ${h.keys.a}`,
    '--checks', CHECKS,
    '--max-examples', process.env.SCHEMATHESIS_MAX_EXAMPLES ?? '40',
    '--seed', process.env.SCHEMATHESIS_SEED ?? '20261002',
    '--request-timeout', '10',
  ];
  const output: string[] = [];
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.on('error', reject);
    child.on('close', resolve);
  }).finally(() => {
    // Conteneur nommé par ce test : retiré s'il reste (délai dépassé, interruption).
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  });
  const report = output.join('');
  if (code !== 0) console.error(report);
  expect(report).toMatch(/passed|No issues found/i);
  expect(code, 'Schemathesis a trouvé des écarts (rapport ci-dessus)').toBe(0);
}, 600_000);
