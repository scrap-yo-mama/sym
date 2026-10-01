// SPDX-License-Identifier: AGPL-3.0-only
// Enveloppe de cosign pour la release à blanc : clé de test locale (jetable, mot de passe vide, jamais commitée), aucun
// journal de transparence, aucun réseau. La release réelle signe SANS clé (OIDC du workflow, journal Rekor) : voir
// .github/workflows/release.yml. Ici on prouve la chaîne signer → vérifier → refuser l'artefact non signé ou altéré.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type TestKey = { privateKey: string; publicKey: string };

function cosign(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('cosign', args, { encoding: 'utf8', env: { ...process.env, COSIGN_PASSWORD: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
}

export function cosignVersion(): string | undefined {
  try {
    return /GitVersion:\s*(\S+)/.exec(cosign(['version']))?.[1];
  } catch {
    return undefined;
  }
}

/** Paire de clés de test dans `dir` (à supprimer après usage). */
export function generateTestKey(dir: string): TestKey {
  mkdirSync(dir, { recursive: true });
  cosign(['generate-key-pair', '--output-key-prefix', join(dir, 'zz_test_cosign')]);
  return { privateKey: join(dir, 'zz_test_cosign.key'), publicKey: join(dir, 'zz_test_cosign.pub') };
}

const OFFLINE_SIGN = ['--use-signing-config=false', '--tlog-upload=false', '--yes'];
const OFFLINE_VERIFY = ['--insecure-ignore-tlog=true'];

/** Signe un fichier : écrit le paquet de signature (bundle) à `bundle`. */
export function signBlob(key: TestKey, file: string, bundle: string): void {
  cosign(['sign-blob', '--key', key.privateKey, '--bundle', bundle, ...OFFLINE_SIGN, file]);
}

/** Vérifie un fichier contre son bundle ; lève si la signature est absente, invalide ou d'une autre clé. */
export function verifyBlob(publicKey: string, file: string, bundle: string): void {
  cosign(['verify-blob', '--key', publicKey, '--bundle', bundle, ...OFFLINE_VERIFY, file]);
}

/** Atteste un prédicat (SBOM CycloneDX, provenance SLSA) sur un fichier sujet. */
export function attestBlob(key: TestKey, subject: string, predicate: string, type: 'cyclonedx' | 'slsaprovenance1', bundle: string): void {
  cosign(['attest-blob', '--key', key.privateKey, '--predicate', predicate, '--type', type, '--bundle', bundle, ...OFFLINE_SIGN, subject]);
}

export function verifyBlobAttestation(publicKey: string, subject: string, type: 'cyclonedx' | 'slsaprovenance1', bundle: string): void {
  cosign(['verify-blob-attestation', '--key', publicKey, '--type', type, '--bundle', bundle, ...OFFLINE_VERIFY, subject]);
}

/** Vrai si `verify` lève : l'artefact est refusé. */
export function refused(verify: () => void): boolean {
  return verifyFailure(verify) !== undefined;
}

/** Motif du refus (sortie d'erreur de cosign), ou `undefined` si la vérification passe. */
export function verifyFailure(verify: () => void): string | undefined {
  try {
    verify();
    return undefined;
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    const text = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
    // cosign écrit d'abord des avertissements (journal de transparence ignoré) : on garde la ligne `Error:`.
    const lines = (text || (error instanceof Error ? error.message : String(error))).split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.find((l) => l.startsWith('Error:')) ?? lines[lines.length - 1] ?? 'refus';
  }
}

export type Refusal = { case: string; refused: boolean; reason: string };

/**
 * Contrôles négatifs (assert_release_signed) : chacun utilise un bundle VALIDE, celui de `signed`, pour que le refus
 * vienne de la vérification de signature et non d'un fichier manquant.
 *   - artefact non signé, présenté avec le bundle d'un autre fichier signé ;
 *   - artefact altéré après signature ;
 *   - bon artefact, vérifié avec une autre clé publique.
 */
export function negativeChecks(options: { key: TestKey; other: TestKey; signed: string; bundle: string; workDir: string }): Refusal[] {
  const { key, other, signed, bundle, workDir } = options;
  mkdirSync(workDir, { recursive: true });
  const unsigned = join(workDir, 'zz_test_unsigned.bin');
  const tampered = join(workDir, 'zz_test_tampered.bin');
  writeFileSync(unsigned, 'artefact sans signature\n');
  copyFileSync(signed, tampered);
  writeFileSync(tampered, Buffer.concat([readFileSync(tampered), Buffer.from('x')]));
  try {
    const cases: [string, () => void][] = [
      ['artefact non signé', () => verifyBlob(key.publicKey, unsigned, bundle)],
      ['artefact altéré après signature', () => verifyBlob(key.publicKey, tampered, bundle)],
      ['signature vérifiée avec une autre clé', () => verifyBlob(other.publicKey, signed, bundle)],
    ];
    return cases.map(([name, verify]) => {
      const reason = verifyFailure(verify);
      return { case: name, refused: reason !== undefined, reason: reason ?? 'accepté' };
    });
  } finally {
    rmSync(unsigned, { force: true });
    rmSync(tampered, { force: true });
  }
}

/** Commande `cosign verify` donnée aux utilisateurs : épingle l'identité du workflow de release et l'émetteur OIDC. */
export function userVerifyCommand(repository: string, tag: string, image: string): string {
  const identity = `https://github.com/${repository}/.github/workflows/release.yml@refs/tags/${tag}`;
  return [
    'cosign verify',
    `--certificate-identity ${identity}`,
    '--certificate-oidc-issuer https://token.actions.githubusercontent.com',
    image,
  ].join(' \\\n  ');
}
