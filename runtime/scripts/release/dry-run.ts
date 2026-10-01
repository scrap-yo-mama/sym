// SPDX-License-Identifier: AGPL-3.0-only
// Release À BLANC (tâche 4.9, recette 28) : rejoue la chaîne de release en local, sans rien publier.
//   étiquette → plan de tags (jamais `latest`) → portes (workflows, licences par paquet) → archive de l'extension + SHA-256
//   → SBOM CycloneDX 1.7 (lockfile, production) → provenance → signature cosign avec une clé de test jetable → vérification
//   → refus de l'artefact non signé, altéré ou signé par une autre clé.
// Rien ne part : ni GHCR, ni image poussée, ni réseau (cosign sans journal de transparence). `--with-image` construit
// l'image LOCALEMENT (docker build, aucun push) pour contrôler l'utilisateur non root et signer son identifiant.
// La release réelle (.github/workflows/release.yml) signe sans clé et ne s'exécute que sur une étiquette approuvée.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkMitPackages } from '../check-licenses.ts';
import { checkRepo as checkGates } from './gates.ts';
import { planRelease, type ReleasePlan } from './plan.ts';
import { catalogNames, checkSbomFile, generateLockfileSbom } from './sbom.ts';
import { checkHistory as checkX6History } from '../check-x6.ts';
import { identityOf, publicRepository, verifyBlock } from '../vitrine/lib/identity.ts';
import { checksumResult, imageLabelProblems, verifySnippetProblems } from '../vitrine/lib/verify.ts';
import { readRepoMetadata } from '../vitrine/lib/surface.ts';
import { readReadme, verifyBlockProblems } from '../vitrine/lib/readme.ts';
import { attestBlob, cosignVersion, generateTestKey, negativeChecks, type Refusal, signBlob, userVerifyCommand, verifyBlob, verifyBlobAttestation } from './sign.ts';

/** Dépôt et image de la release réelle, lus dans l'identité publique (PUBLIC_REPOSITORY, 4.12) ; rien n'y est publié. */
export const REPOSITORY = publicRepository();
export const IMAGE = identityOf(REPOSITORY).image;

export type Artifact = { name: string; sha256: string; bytes: number };
export type DryRunReport = {
  plan: ReleasePlan;
  cosign: string;
  artifacts: Artifact[];
  /** Fichiers dont la signature (ou l'attestation) a été vérifiée avec la clé de test. */
  verified: string[];
  /** Contrôles négatifs : chacun doit être refusé, sur la vérification de signature (bundle valide d'un autre fichier). */
  refusals: Refusal[];
  image?: { reference: string; id: string; user: string; uid: string; labels: Record<string, string> };
  /** `assert_verify_snippet_works` : sha256sum -c rejoué sur SHA256SUMS de la release à blanc ; identité du bloc « Verify » du README. */
  verifySnippet: { checksum: string };
  verifyCommand: string;
};

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

/**
 * Archive WXT de la version annoncée (`<nom>-<version>-chrome.zip`, gabarit par défaut `{{packageVersion}}`). Une archive
 * d'une autre version restée dans dist/ n'est jamais prise : la signer reviendrait à publier une autre version.
 */
export function findExtensionZip(files: readonly string[], version: string): string {
  const matches = files.filter((f) => f.endsWith(`-${version}-chrome.zip`));
  if (matches.length !== 1) {
    throw new Error(`archive de l'extension ${version} : ${matches.length === 0 ? 'introuvable' : `ambiguë (${matches.join(', ')})`} dans apps/extension/dist (la version de apps/extension/package.json doit être celle de l'étiquette)`);
  }
  return matches[0] as string;
}

function describeArtifact(dir: string, name: string): Artifact {
  const path = join(dir, name);
  return { name, sha256: sha256(path), bytes: readFileSync(path).length };
}

/** Construit l'image en local (aucun push), contrôle l'utilisateur non root et renvoie son identifiant. */
function buildLocalImage(runtimeDir: string, plan: ReleasePlan): NonNullable<DryRunReport['image']> {
  const local = `zz_test_release:${plan.version}`;
  try {
    sh('docker', ['build', '--quiet', '-f', 'deploy/Dockerfile', '--build-arg', `RUNTIME_VERSION=${plan.version}`, '-t', local, '.'], runtimeDir);
    const id = sh('docker', ['image', 'inspect', '--format', '{{.Id}}', local], runtimeDir);
    const user = sh('docker', ['image', 'inspect', '--format', '{{.Config.User}}', local], runtimeDir);
    // Par le point d'entrée de l'image (USER root, descente aussitôt sur pwuser) : uid sous lequel tourne une commande.
    const uid = sh('docker', ['run', '--rm', local, 'id', '-u'], runtimeDir);
    const labels = JSON.parse(sh('docker', ['image', 'inspect', '--format', '{{json .Config.Labels}}', local], runtimeDir)) as Record<string, string>;
    return { reference: `${IMAGE}:${plan.version}`, id, user, uid, labels };
  } finally {
    try {
      sh('docker', ['rmi', '--force', local], runtimeDir);
    } catch {
      // image déjà supprimée
    }
  }
}

export function runDryRun(options: { runtimeDir: string; tag?: string; outDir?: string; withImage?: boolean }): DryRunReport {
  const { runtimeDir } = options;
  const pkg = JSON.parse(readFileSync(join(runtimeDir, 'package.json'), 'utf8')) as { version: string };
  const plan = planRelease(options.tag ?? `v${pkg.version}`);
  // Portes, dont l'audit X6 de tout l'historique git (X6 : avant chaque release publique).
  const problems = [...checkGates(runtimeDir), ...checkMitPackages(runtimeDir), ...checkX6History(runtimeDir)];
  if (problems.length > 0) throw new Error(`portes de release en échec :\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  const out = options.outDir ?? mkdtempSync(join(tmpdir(), 'zz_test_release-'));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const keyDir = mkdtempSync(join(tmpdir(), 'zz_test_cosign-'));
  try {
    // 1. Archive de l'extension (WXT, reproductible) et SHA-256.
    const dist = join(runtimeDir, 'apps/extension/dist');
    if (existsSync(dist)) for (const f of readdirSync(dist).filter((n) => n.endsWith('.zip'))) rmSync(join(dist, f));
    sh('pnpm', ['--filter', '@runtime/extension', 'exec', 'wxt', 'zip'], runtimeDir);
    const extensionZip = `scrapyomama-extension-${plan.version}.zip`;
    // Avant la première release, l'extension porte déjà une version valide pour Chrome (0.1.0, tâche 2.9) alors que le
    // dépôt est à 0.0.0 : release-please les aligne (extra-files). L'archive est donc cherchée sous la version PROPRE de
    // l'extension ; le fichier de sortie, lui, porte la version de l'étiquette.
    const extVersion = (JSON.parse(readFileSync(join(runtimeDir, 'apps/extension/package.json'), 'utf8')) as { version: string }).version;
    if (extVersion !== plan.version) console.warn(`avertissement : apps/extension/package.json porte ${extVersion}, l'étiquette ${plan.version} : release-please aligne les deux à la release.`);
    copyFileSync(join(dist, findExtensionZip(readdirSync(dist), extVersion)), join(out, extensionZip));
    writeFileSync(join(out, `${extensionZip}.sha256`), `${sha256(join(out, extensionZip))}  ${extensionZip}\n`);

    // 2. SBOM CycloneDX 1.7 : lockfile complet, et production seule (stand-in local du SBOM de l'image, que syft produit en release).
    const catalog = catalogNames(readFileSync(join(runtimeDir, 'pnpm-workspace.yaml'), 'utf8'));
    generateLockfileSbom(runtimeDir, join(out, 'sbom-lockfile.cdx.json'));
    generateLockfileSbom(runtimeDir, join(out, 'sbom-production.cdx.json'), { prod: true });
    const sbomProblems = [...checkSbomFile(join(out, 'sbom-lockfile.cdx.json'), catalog), ...checkSbomFile(join(out, 'sbom-production.cdx.json'))];
    if (sbomProblems.length > 0) throw new Error(sbomProblems.join('\n'));

    // 3. Image (optionnelle, locale) : son identifiant devient le sujet signé.
    const image = options.withImage ? buildLocalImage(runtimeDir, plan) : undefined;
    if (image && image.uid !== '1001') throw new Error(`l'image ne descend pas sur pwuser (uid ${image.uid}, USER ${image.user || 'vide'})`);
    // assert_image_labels (4.12) : étiquettes OCI de l'image construite = identité publique.
    if (image) {
      const labelProblems = imageLabelProblems(image.labels, identityOf(REPOSITORY), readRepoMetadata().description);
      if (labelProblems.length > 0) throw new Error(`étiquettes de l'image : ${labelProblems.join(' ; ')}`);
    }
    if (image) writeFileSync(join(out, 'image.json'), `${JSON.stringify({ reference: image.reference, tags: plan.imageTags, digest: image.id }, null, 2)}\n`);

    // 4. Provenance : prédicat SLSA v1 minimal. La provenance dit qui a construit et d'où, pas que l'artefact est sain.
    const commit = sh('git', ['rev-parse', 'HEAD'], runtimeDir);
    writeFileSync(join(out, 'provenance.predicate.json'), `${JSON.stringify({
      buildDefinition: { buildType: 'urn:scrapyomama:release:dry-run:v1', externalParameters: { tag: plan.tag, channel: plan.channel }, resolvedDependencies: [{ uri: 'git+local', digest: { gitCommit: commit } }] },
      runDetails: { builder: { id: 'urn:scrapyomama:builder:local-dry-run' }, metadata: { invocationId: `dry-run-${plan.version}` } },
    }, null, 2)}\n`);

    // 5. Sommes de contrôle de la release.
    const subjects = [extensionZip, 'sbom-lockfile.cdx.json', 'sbom-production.cdx.json', ...(image ? ['image.json'] : [])];
    writeFileSync(join(out, 'SHA256SUMS'), `${subjects.map((n) => `${sha256(join(out, n))}  ${n}`).join('\n')}\n`);
    subjects.push('SHA256SUMS');
    // assert_verify_snippet_works (4.12) : le bloc « Verify » du README cite l'identité de cette chaîne, et `sha256sum -c` réussit.
    const identity = identityOf(REPOSITORY);
    const snippet = [
      ...verifySnippetProblems(verifyBlock(identity), identity),
      ...(['en', 'fr'] as const).flatMap((lang) => verifyBlockProblems(readReadme(lang), identity).map((p) => `README ${lang} : ${p}`)),
    ];
    const sums = checksumResult(out);
    if (snippet.length > 0 || !sums.ok) throw new Error(`bloc « Verify » : ${[...snippet, ...(sums.ok ? [] : [`sha256sum -c : ${sums.output}`])].join(' ; ')}`);

    // 6. Signature (clé de test jetable), attestations de SBOM et de provenance.
    const key = generateTestKey(keyDir);
    // Clé PUBLIQUE de test jointe : un tiers vérifie avec `cosign verify-blob --key cosign.pub --bundle <fichier>.bundle <fichier>`.
    copyFileSync(key.publicKey, join(out, 'cosign.pub'));
    for (const name of subjects) signBlob(key, join(out, name), join(out, `${name}.bundle`));
    attestBlob(key, join(out, extensionZip), join(out, 'sbom-production.cdx.json'), 'cyclonedx', join(out, `${extensionZip}.sbom.att.bundle`));
    attestBlob(key, join(out, extensionZip), join(out, 'provenance.predicate.json'), 'slsaprovenance1', join(out, `${extensionZip}.provenance.att.bundle`));

    // 7. Vérification (le « tiers » : clé publique seule).
    const verified: string[] = [];
    for (const name of subjects) {
      verifyBlob(key.publicKey, join(out, name), join(out, `${name}.bundle`));
      verified.push(name);
    }
    verifyBlobAttestation(key.publicKey, join(out, extensionZip), 'cyclonedx', join(out, `${extensionZip}.sbom.att.bundle`));
    verifyBlobAttestation(key.publicKey, join(out, extensionZip), 'slsaprovenance1', join(out, `${extensionZip}.provenance.att.bundle`));
    verified.push(`${extensionZip} (attestation cyclonedx)`, `${extensionZip} (attestation slsaprovenance1)`);

    // 8. Refus : non signé (présenté avec le bundle valide de l'archive), altéré, autre clé.
    const other = generateTestKey(join(keyDir, 'autre'));
    const refusals = negativeChecks({ key, other, signed: join(out, extensionZip), bundle: join(out, `${extensionZip}.bundle`), workDir: join(keyDir, 'negatifs') });
    const failedRefusal = refusals.find((r) => !r.refused || /no such file|ENOENT/i.test(r.reason));
    if (failedRefusal) throw new Error(`contrôle négatif accepté à tort : ${failedRefusal.case}`);

    const artifacts = readdirSync(out).sort().map((name) => describeArtifact(out, name));
    const report: DryRunReport = {
      plan, cosign: cosignVersion() ?? 'inconnue', artifacts, verified, refusals,
      ...(image ? { image } : {}),
      verifySnippet: { checksum: sums.output.split('\n').filter(Boolean).join(' ; ') },
      verifyCommand: userVerifyCommand(REPOSITORY, plan.tag, `${IMAGE}@sha256:<empreinte>`),
    };
    writeFileSync(join(out, 'release-report.json'), `${JSON.stringify(report, null, 2)}\n`);
    return report;
  } finally {
    rmSync(keyDir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(name);
  const value = (name: string) => args[args.indexOf(name) + 1];
  const runtimeDir = new URL('../..', import.meta.url).pathname;
  const outDir = flag('--out') ? value('--out') : join(tmpdir(), 'zz_test_release-out');
  const report = runDryRun({ runtimeDir, outDir, withImage: flag('--with-image'), ...(flag('--tag') && value('--tag') ? { tag: value('--tag') as string } : {}) });
  console.log(`release à blanc ${report.plan.tag} (canal ${report.plan.channel}) : cosign ${report.cosign}`);
  console.log(`  tags d'image : ${report.plan.imageTags.join(', ')} (jamais latest)`);
  for (const a of report.artifacts) console.log(`  ${a.sha256.slice(0, 12)}  ${String(a.bytes).padStart(9)}  ${a.name}`);
  console.log(`  vérifiés : ${report.verified.length} (cosign verify-blob / verify-blob-attestation : OK)`);
  console.log(`  bloc « Verify » du README : identité conforme ; sha256sum -c SHA256SUMS : ${report.verifySnippet.checksum.replace(/\s+/g, ' ').slice(0, 120)}`);
  for (const r of report.refusals) console.log(`  refus attendu : ${r.case} -> ${r.refused ? `refusé (${r.reason})` : 'ACCEPTÉ'}`);
  if (report.image) console.log(`  image locale : uid ${report.image.uid}, USER ${report.image.user}, id ${report.image.id.slice(0, 19)}… (rien de poussé)`);
  console.log(`  sorties : ${outDir}`);
}
