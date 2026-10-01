// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.9 : chaîne de release. assert_release_gates, assert_sbom_present, assert_release_signed, plus les règles de
// version (SemVer 0.y, canaux, jamais `latest`), les licences par paquet (D-10) et les commits conventionnels.
// cosign est exécuté pour de bon avec une clé de test jetable (aucun réseau, aucune publication) ; les fixtures ne
// contiennent que des fragments de workflow ou de manifeste à refuser.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { checkMitPackages, classifyForMit, evaluateMitPackage, parseLicenseReport } from '../scripts/check-licenses.ts';
import { checkSubject, isBreaking } from '../scripts/release/conventional.ts';
import { checkImageNonRoot, checkReleaseWorkflow, checkRepo as checkGates, checkWorkflowSecurity } from '../scripts/release/gates.ts';
import { checkTagMatchesPackage, imageReferences, planRelease, ReleaseTagError } from '../scripts/release/plan.ts';
import { catalogNames, checkSbomFile, generateLockfileSbom, validateSbom } from '../scripts/release/sbom.ts';
import { attestBlob, cosignVersion, generateTestKey, refused, signBlob, userVerifyCommand, verifyBlob, verifyBlobAttestation, type TestKey } from '../scripts/release/sign.ts';

const runtimeDir = new URL('..', import.meta.url).pathname;
const repoDir = join(runtimeDir, '..');
const SHA = 'a'.repeat(40);

/** Workflow de release conforme : modèle des cas négatifs ci-dessous. */
const GOOD_RELEASE = `name: release
on:
  push:
    tags:
      - 'v[0-9]+.[0-9]+.[0-9]+'
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-24.04
    environment: release
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@${SHA} # v1
        with:
          persist-credentials: false
      - run: pnpm install --frozen-lockfile
      - run: |
          cosign sign --yes "$IMAGE"
          cosign attest --yes --type cyclonedx --predicate sbom.json "$IMAGE"
          cosign sign-blob --yes --bundle b f
      - uses: actions/attest-build-provenance@${SHA} # v1
`;

describe('release : portes (assert_release_gates)', () => {
  test('assert_release_gates : action non épinglée, pull_request_target avec code de PR, donnée de tiers dans un script', () => {
    expect(checkReleaseWorkflow('r', GOOD_RELEASE)).toEqual([]);
    // Action non épinglée par SHA complet.
    expect(checkReleaseWorkflow('r', GOOD_RELEASE.replace(`actions/checkout@${SHA} # v1`, 'actions/checkout@v4'))).toHaveLength(1);
    // pull_request_target qui exécute du code, ou extrait la PR.
    const target = (steps: string) => `on:\n  pull_request_target:\npermissions:\n  contents: read\njobs:\n  j:\n    steps:\n${steps}`;
    expect(checkWorkflowSecurity('w', target('      - run: pnpm test\n'))).toHaveLength(1);
    expect(checkWorkflowSecurity('w', target(`      - uses: actions/checkout@${SHA} # v1\n        with:\n          ref: \${{ github.event.pull_request.head.sha }}\n`))).toHaveLength(1);
    expect(checkWorkflowSecurity('w', target(`      - uses: org/labeler@${SHA} # v1\n`))).toEqual([]);
    // Titre de PR interpolé dans un script : injection.
    const inject = `on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  j:\n    steps:\n      - run: echo "\${{ github.event.pull_request.title }}"\n`;
    expect(checkWorkflowSecurity('w', inject)).toHaveLength(1);
    const injectBlock = `on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  j:\n    steps:\n      - run: |\n          echo ok\n          echo "\${{ github.head_ref }}"\n`;
    expect(checkWorkflowSecurity('w', injectBlock)).toHaveLength(1);
    // Passé par l'environnement : accepté.
    expect(checkWorkflowSecurity('w', inject.replace('echo "${{ github.event.pull_request.title }}"', 'echo "$T"\n        env:\n          T: ${{ github.event.pull_request.title }}'))).toEqual([]);
  });

  test('assert_release_gates : release par étiquette, environnement, sans cache, permissions, signature, SBOM, provenance', () => {
    const bad = (from: string, to: string) => checkReleaseWorkflow('r', GOOD_RELEASE.replace(from, to));
    // Déclenchée par une branche ou à la main : refus.
    expect(bad("    tags:\n      - 'v[0-9]+.[0-9]+.[0-9]+'", '    branches: [main]')).not.toEqual([]);
    expect(bad('on:\n  push:', 'on:\n  workflow_dispatch:\n  push:')).not.toEqual([]);
    expect(bad('on:\n  push:', 'on:\n  pull_request:\n  push:')).not.toEqual([]);
    // Pas d'environnement à relecteurs.
    expect(bad('    environment: release\n', '')).toHaveLength(1);
    // Cache.
    expect(bad('      - run: pnpm install', `      - uses: actions/cache@${SHA} # v1\n      - run: pnpm install`)).toHaveLength(1);
    expect(bad('      - uses: actions/attest', '      - uses: docker/build-push-action@' + SHA + ' # v1\n        with:\n          cache-from: type=gha\n      - uses: actions/attest')).toHaveLength(1);
    // Écriture au niveau du workflow, OIDC absent.
    expect(bad('permissions:\n  contents: read\njobs', 'permissions:\n  contents: write\njobs')).toHaveLength(1);
    expect(bad('      id-token: write\n', '')).toHaveLength(1);
    // Tag flottant.
    expect(bad('"$IMAGE"\n          cosign attest', '"img:latest"\n          cosign attest')).toHaveLength(1);
    // Identifiants persistés par checkout.
    expect(bad('        with:\n          persist-credentials: false\n', '')).toHaveLength(1);
    // Chaîne incomplète : ni signature, ni SBOM attesté, ni provenance.
    expect(bad('cosign sign-blob --yes --bundle b f', 'true')).toHaveLength(1);
    expect(bad('          cosign attest --yes --type cyclonedx --predicate sbom.json "$IMAGE"\n', '')).toHaveLength(1);
    expect(bad(`      - uses: actions/attest-build-provenance@${SHA} # v1\n`, '')).toHaveLength(1);
  });

  test('assert_image_nonroot : le dernier stage du Dockerfile tourne en non root (USER)', () => {
    expect(checkImageNonRoot('d', 'FROM a AS b\nUSER root\nFROM c AS r\nUSER pwuser\n')).toEqual([]);
    expect(checkImageNonRoot('d', 'FROM a AS b\nUSER pwuser\nFROM c AS r\nRUN true\n')).toHaveLength(1);
    expect(checkImageNonRoot('d', 'FROM c\nUSER 0\n')).toHaveLength(1);
    expect(checkImageNonRoot('d', 'FROM c\nUSER 1001:1001\n')).toEqual([]);
  });

  test('assert_release_gates : dépôt réel (workflows, release.yml, Dockerfile)', () => {
    expect(checkGates(runtimeDir)).toEqual([]);
  });
});

describe('release : SBOM CycloneDX (assert_sbom_present)', () => {
  const GOOD = {
    bomFormat: 'CycloneDX', specVersion: '1.7', serialNumber: 'urn:uuid:a8d9dec5-1af7-4a14-bc67-9fcc8d226fd8',
    metadata: { component: { name: 'runtime', version: '0.0.0' } },
    components: [{ type: 'library', name: 'fastify', version: '5.12.5', purl: 'pkg:npm/fastify@5.12.5' }, { type: 'library', group: '@types', name: 'node', version: '24.13.6', purl: 'pkg:npm/%40types/node@24.13.6' }],
  };
  const sbom = (patch: object) => JSON.stringify({ ...GOOD, ...patch });

  test('assert_sbom_present : fixtures', () => {
    expect(validateSbom(JSON.stringify(GOOD), ['fastify', '@types/node'])).toEqual([]);
    expect(validateSbom('pas du json')).toHaveLength(1);
    expect(validateSbom(sbom({ bomFormat: 'SPDX' }))).toHaveLength(1);
    expect(validateSbom(sbom({ specVersion: '1.5' }))).toHaveLength(1);
    expect(validateSbom(sbom({ serialNumber: 'abc' }))).toHaveLength(1);
    expect(validateSbom(sbom({ metadata: {} }))).toHaveLength(1);
    expect(validateSbom(sbom({ components: [] }))).toHaveLength(1);
    expect(validateSbom(sbom({ components: [{ name: 'a', version: '1' }] }))).toHaveLength(1);
    expect(validateSbom(JSON.stringify(GOOD), ['fastify', 'absent'])).toHaveLength(1);
    expect(checkSbomFile(join(tmpdir(), 'zz_test_absent.cdx.json'))).toHaveLength(1);
    expect(catalogNames("catalog:\n  a: 1.0.0\n  '@b/c': 2.0.0 # x\nautre:\n  d: 3\n")).toEqual(['a', '@b/c']);
  });

  test('assert_sbom_present : SBOM réel du lockfile (pnpm sbom, CycloneDX 1.7), chaque dépendance du catalogue y figure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zz_test_sbom-'));
    try {
      const out = join(dir, 'sbom.cdx.json');
      generateLockfileSbom(runtimeDir, out);
      expect(checkSbomFile(out, catalogNames(readFileSync(join(runtimeDir, 'pnpm-workspace.yaml'), 'utf8')))).toEqual([]);
      const prod = join(dir, 'prod.cdx.json');
      generateLockfileSbom(runtimeDir, prod, { prod: true });
      expect(checkSbomFile(prod)).toEqual([]);
      expect(readFileSync(prod, 'utf8').length).toBeLessThan(readFileSync(out, 'utf8').length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('release : signature cosign (assert_release_signed)', () => {
  let dir = '';
  let key: TestKey;
  let other: TestKey;

  beforeAll(() => {
    // En CI, cosign est installé par cosign-installer : son absence est un échec, jamais un test ignoré.
    expect(cosignVersion(), 'cosign introuvable dans le PATH').toBeDefined();
    dir = mkdtempSync(join(tmpdir(), 'zz_test_signed-'));
    key = generateTestKey(join(dir, 'k1'));
    other = generateTestKey(join(dir, 'k2'));
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('assert_release_signed : signé puis vérifié ; non signé, altéré ou autre clé : refus', () => {
    const file = join(dir, 'artefact.zip');
    const bundle = `${file}.bundle`;
    writeFileSync(file, 'contenu de la release');
    signBlob(key, file, bundle);
    expect(refused(() => verifyBlob(key.publicKey, file, bundle))).toBe(false);
    // Non signé : aucun paquet de signature.
    expect(refused(() => verifyBlob(key.publicKey, file, join(dir, 'absent.bundle')))).toBe(true);
    // Autre clé.
    expect(refused(() => verifyBlob(other.publicKey, file, bundle))).toBe(true);
    // Altéré après signature.
    const tampered = join(dir, 'altere.zip');
    writeFileSync(tampered, 'contenu de la release, modifié');
    expect(refused(() => verifyBlob(key.publicKey, tampered, bundle))).toBe(true);
  }, 60_000);

  test('assert_release_signed : SBOM et provenance attestés, vérifiés avec le type attendu', () => {
    const subject = join(dir, 'sujet.zip');
    writeFileSync(subject, 'sujet');
    const sbom = join(dir, 'sbom.cdx.json');
    generateLockfileSbom(runtimeDir, sbom, { prod: true });
    const att = `${subject}.sbom.att.bundle`;
    attestBlob(key, subject, sbom, 'cyclonedx', att);
    expect(refused(() => verifyBlobAttestation(key.publicKey, subject, 'cyclonedx', att))).toBe(false);
    // Mauvais type de prédicat, mauvaise clé, autre sujet.
    expect(refused(() => verifyBlobAttestation(key.publicKey, subject, 'slsaprovenance1', att))).toBe(true);
    expect(refused(() => verifyBlobAttestation(other.publicKey, subject, 'cyclonedx', att))).toBe(true);
    const another = join(dir, 'autre.zip');
    writeFileSync(another, 'autre');
    expect(refused(() => verifyBlobAttestation(key.publicKey, another, 'cyclonedx', att))).toBe(true);
    const provenance = join(dir, 'provenance.json');
    writeFileSync(provenance, JSON.stringify({ buildDefinition: { buildType: 'urn:test', externalParameters: {} }, runDetails: { builder: { id: 'urn:test' } } }));
    const patt = `${subject}.prov.att.bundle`;
    attestBlob(key, subject, provenance, 'slsaprovenance1', patt);
    expect(refused(() => verifyBlobAttestation(key.publicKey, subject, 'slsaprovenance1', patt))).toBe(false);
  }, 60_000);

  test('assert_release_signed : la commande donnée aux utilisateurs épingle l\'identité du workflow de release', () => {
    const cmd = userVerifyCommand('org/depot', 'v0.1.0', 'ghcr.io/org/depot@sha256:abc');
    expect(cmd).toContain('--certificate-identity https://github.com/org/depot/.github/workflows/release.yml@refs/tags/v0.1.0');
    expect(cmd).toContain('--certificate-oidc-issuer https://token.actions.githubusercontent.com');
    expect(cmd).not.toContain('regexp');
    // Le README de déploiement publie cette commande.
    expect(readFileSync(join(runtimeDir, 'docs/release.md'), 'utf8')).toContain('--certificate-identity');
  });

  test('assert_release_signed : le workflow de release signe l\'image et chaque fichier sans clé (OIDC)', () => {
    const yaml = readFileSync(join(repoDir, '.github/workflows/release.yml'), 'utf8');
    expect(yaml).toMatch(/cosign sign --yes "\$\{IMAGE\}@\$\{DIGEST\}"/);
    expect(yaml).toMatch(/cosign attest --yes --type cyclonedx/);
    expect(yaml).toMatch(/cosign sign-blob --yes --bundle/);
    expect(yaml).not.toMatch(/--key\b|COSIGN_PRIVATE_KEY|COSIGN_PASSWORD/);
    expect(yaml).toMatch(/environment: release/);
  });
});

describe('release : version, canaux, tags (16 §3, 14 §6)', () => {
  test('SemVer 0.y.z : étiquette stable et beta, tags d\'image, jamais latest', () => {
    expect(planRelease('v0.4.2')).toMatchObject({ version: '0.4.2', channel: 'stable', imageTags: ['0.4.2', '0.4', '0', 'stable'], preOne: true });
    expect(planRelease('v1.2.3').preOne).toBe(false);
    expect(planRelease('v0.5.0-beta.3')).toMatchObject({ version: '0.5.0-beta.3', channel: 'beta', imageTags: ['0.5.0-beta.3', 'beta'] });
    for (const tag of ['0.1.0', 'v0.1', 'v01.2.3', 'v0.1.0-rc.1', 'v0.1.0-beta', 'latest', 'v0.1.0-beta.1+build', 'v0.1.0 ', 'vlatest']) {
      expect(() => planRelease(tag), tag).toThrow(ReleaseTagError);
    }
    for (const tag of ['v0.4.2', 'v0.5.0-beta.3', 'v1.0.0']) expect(planRelease(tag).imageTags).not.toContain('latest');
    // Une beta ne déplace jamais `stable`, ni X.Y, ni X.
    expect(planRelease('v0.5.0-beta.3').imageTags).not.toContain('stable');
    expect(imageReferences(planRelease('v0.4.2'), 'ghcr.io/o/r')).toEqual(['ghcr.io/o/r:0.4.2', 'ghcr.io/o/r:0.4', 'ghcr.io/o/r:0', 'ghcr.io/o/r:stable']);
  });

  test('la version du package.json doit être celle de l\'étiquette', () => {
    expect(checkTagMatchesPackage(planRelease('v0.4.2'), '{"version":"0.4.2"}')).toEqual([]);
    expect(checkTagMatchesPackage(planRelease('v0.4.2'), '{"version":"0.4.1"}')).toHaveLength(1);
    expect(checkTagMatchesPackage(planRelease('v0.4.2'), '{}')).toHaveLength(1);
  });

  test('version unique pour le monorepo : release-please met à jour chaque package.json du workspace', () => {
    const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const stable = read(join(repoDir, 'release-please-config.json'));
    const beta = read(join(repoDir, 'release-please-config.beta.json'));
    const manifest = read(join(repoDir, '.release-please-manifest.json'));
    const root = read(join(runtimeDir, 'package.json')) as { version: string };
    expect(manifest).toEqual({ runtime: root.version });
    for (const config of [stable, beta]) {
      expect(config['release-type']).toBe('node');
      // SemVer 0.y : un changement cassant monte la MINOR, une fonction ne monte pas de MAJOR.
      expect(config['bump-minor-pre-major']).toBe(true);
      expect(Object.keys(config['packages'] as object)).toEqual(['runtime']);
    }
    expect(stable['prerelease']).toBeUndefined();
    expect(beta['prerelease']).toBe(true);
    expect(beta['prerelease-type']).toBe('beta');
    const extra = ((stable['packages'] as Record<string, { 'extra-files': { path: string }[] }>)['runtime']?.['extra-files'] ?? []).map((f) => f.path.replace(/\/package.json$/, '')).sort();
    const workspace = ['apps', 'packages'].flatMap((d) => readdirSync(join(runtimeDir, d)).map((n) => `${d}/${n}`)).concat('fixtures').sort();
    expect(extra).toEqual(workspace);
    for (const dir of workspace) expect(read(join(runtimeDir, dir, 'package.json'))['version'], dir).toBe(root.version);
    // La beta lit la même liste de fichiers que la stable.
    expect((beta['packages'] as object)).toEqual(stable['packages']);
  });

  test('commits conventionnels : sujets conformes, changement cassant détecté', () => {
    for (const ok of ['feat: ajoute la release à blanc', 'fix(server): corrige /api/ready', 'feat(api)!: renomme le champ', 'chore(deps): met à jour pg', 'Merge branch main']) {
      expect(checkSubject(ok), ok).toBeUndefined();
    }
    for (const bad of ['ajoute la release', 'Feat: x', 'feat:x', 'feat: ', 'wip: x', 'feat(): x', `feat: ${'x'.repeat(101)}`]) {
      expect(checkSubject(bad), bad).toBeDefined();
    }
    expect(isBreaking('feat!: x')).toBe(true);
    expect(isBreaking('fix(api)!: x')).toBe(true);
    expect(isBreaking('feat: x', 'texte\n\nBREAKING CHANGE: le champ disparaît')).toBe(true);
    expect(isBreaking('feat: x', 'aucun')).toBe(false);
  });
});

describe('release : licences par paquet (D-10, 16 §1)', () => {
  const MIT = new Set(['@runtime/client', '@runtime/schemas']);
  const dep = (name: string) => ({ name, versions: ['1.0.0'] });
  const manifest = { name: '@runtime/client', license: 'MIT', dependencies: {} };

  test('client et schemas : aucune dépendance copyleft, aucun paquet AGPL du workspace', () => {
    expect(evaluateMitPackage('client', manifest, { MIT: [dep('a')], 'Apache-2.0': [dep('b')], '(MIT OR GPL-3.0-only)': [dep('c')] }, MIT)).toEqual([]);
    for (const copyleft of ['GPL-2.0-only', 'GPL-3.0-or-later', 'LGPL-3.0-only', 'AGPL-3.0-only', 'MPL-2.0', 'EPL-2.0', 'CC-BY-SA-4.0', 'SSPL-1.0', 'GPL-2.0-only AND MIT']) {
      expect(evaluateMitPackage('client', manifest, { [copyleft]: [dep('x')] }, MIT), copyleft).toHaveLength(1);
    }
    expect(evaluateMitPackage('client', manifest, { 'Inconnue-1.0': [dep('x')] }, MIT)).toHaveLength(1);
    expect(evaluateMitPackage('client', manifest, { 'GPL-3.0-only': [dep('x')] }, MIT, { x: 'exception justifiée' })).toEqual([]);
    expect(evaluateMitPackage('client', { ...manifest, license: 'AGPL-3.0-only' }, {}, MIT)).toHaveLength(1);
    // Dépendre du cœur (AGPL) ou d'un paquet quelconque du workspace non MIT.
    expect(evaluateMitPackage('schemas', { ...manifest, dependencies: { '@runtime/core': 'workspace:*' } }, {}, MIT)).toHaveLength(1);
    expect(evaluateMitPackage('client', { ...manifest, dependencies: { '@runtime/schemas': 'workspace:*' } }, {}, MIT)).toEqual([]);
    expect(evaluateMitPackage('client', { ...manifest, peerDependencies: { autre: 'workspace:*' } }, {}, MIT)).toHaveLength(1);
    expect(classifyForMit('MIT OR GPL-3.0-only')).toBe('allowed');
    expect(classifyForMit('GPL-2.0')).toBe('forbidden');
    expect(parseLicenseReport('No licenses in packages found')).toEqual({});
    expect(parseLicenseReport('{"MIT":[]}')).toEqual({ MIT: [] });
  });

  test('client et schemas : dépôt réel', () => {
    expect(checkMitPackages(runtimeDir)).toEqual([]);
    // Un rapport de licences simulé avec une dépendance GPL fait échouer le contrôle réel.
    mkdirSync(join(tmpdir()), { recursive: true });
    expect(checkMitPackages(runtimeDir, () => ({ 'GPL-2.0-only': [dep('zz_test_gpl')] }))).toHaveLength(2);
  }, 60_000);
});
