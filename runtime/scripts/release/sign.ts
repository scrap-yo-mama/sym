// SPDX-License-Identifier: AGPL-3.0-only
// Enveloppe de cosign pour la release à blanc : clé de test locale (jetable, mot de passe vide, jamais commitée), aucun
// journal de transparence, aucun réseau. La release réelle signe SANS clé (OIDC du workflow, journal Rekor) : voir
// .github/workflows/release.yml. Ici on prouve la chaîne signer → vérifier → refuser l'artefact non signé ou altéré.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
  try {
    verify();
    return false;
  } catch {
    return true;
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
