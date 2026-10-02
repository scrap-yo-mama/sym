// SPDX-License-Identifier: AGPL-3.0-only
// Identité publique du dépôt (22 §3.1, 22b §1) : une seule source, jamais une constante dans un test ni une page.
// Source : la variable de dépôt `PUBLIC_REPOSITORY` quand elle est posée (CI), sinon le fichier versionné
// `.github/PUBLIC_REPOSITORY` (une ligne `propriétaire/dépôt`). Sur le dépôt public, elle doit égaler `GITHUB_REPOSITORY`.
// Tout ce qui cite le propriétaire (bloc « Verify », étiquettes OCI, liens du README) en est dérivé.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { githubDir } from './paths.ts';

const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

export type PublicIdentity = {
  repository: string;
  owner: string;
  name: string;
  /** `https://github.com/<propriétaire>/<dépôt>` */
  url: string;
  /** Image GHCR (en minuscules, comme l'exige GHCR). */
  image: string;
  /** Nom du serveur dans le registre MCP : `io.github.<propriétaire>/<dépôt>`. */
  mcpName: string;
  /** Émetteur OIDC des signatures sans clé. */
  oidcIssuer: string;
};

export const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';

export function parseRepository(value: string): string {
  const repository = value.trim();
  if (!REPOSITORY_PATTERN.test(repository)) throw new Error(`PUBLIC_REPOSITORY invalide : « ${repository} » (attendu : propriétaire/dépôt)`);
  return repository;
}

/** Lit l'identité publique. `env` : variables d'environnement ; `file` : contenu du fichier versionné (tests). */
export function publicRepository(options: { env?: Record<string, string | undefined>; file?: string } = {}): string {
  const env = options.env ?? process.env;
  const fromEnv = env['PUBLIC_REPOSITORY']?.trim();
  if (fromEnv) return parseRepository(fromEnv);
  return parseRepository(options.file ?? readFileSync(join(githubDir, 'PUBLIC_REPOSITORY'), 'utf8'));
}

export function identityOf(repository: string): PublicIdentity {
  const [owner = '', name = ''] = parseRepository(repository).split('/');
  return {
    repository,
    owner,
    name,
    url: `https://github.com/${repository}`,
    image: `ghcr.io/${repository.toLowerCase()}`,
    mcpName: `io.github.${repository}`,
    oidcIssuer: OIDC_ISSUER,
  };
}

/** Identité du certificat de signature : le workflow de release pour une étiquette donnée. */
export function certificateIdentity(identity: PublicIdentity, tag: string): string {
  return `${identity.url}/.github/workflows/release.yml@refs/tags/${tag}`;
}

/**
 * Bloc « Verify what you download » (identique en en et en fr, octet pour octet). `X.Y.Z` est à remplacer par la version.
 * `sha256sum -c` se joue dans le dossier des fichiers téléchargés (SHA256SUMS joint à la release).
 */
export function verifyBlock(identity: PublicIdentity): string {
  return [
    `cosign verify ${identity.image}:X.Y.Z \\`,
    `  --certificate-identity=${certificateIdentity(identity, 'vX.Y.Z')} \\`,
    `  --certificate-oidc-issuer=${identity.oidcIssuer}`,
    `gh attestation verify oci://${identity.image}:X.Y.Z -R ${identity.repository}`,
    'sha256sum -c SHA256SUMS',
  ].join('\n');
}

/**
 * Garde d'identité : sur le dépôt public, `PUBLIC_REPOSITORY` égale `GITHUB_REPOSITORY`. Renvoie les problèmes
 * (liste vide : cohérent). Hors CI (pas de `GITHUB_REPOSITORY`), seule la forme est vérifiée.
 * `enforceRunningRepository: false` : contrôles de la vitrine (job `vitrine`), qui tournent aussi sur le dépôt de travail
 * privé (`…/sym-workspace`, D-44) où les PR sont ouvertes ; seule la release (`check.mjs identity`) exige l'égalité.
 */
export function identityProblems(env: Record<string, string | undefined>, file: string, options: { enforceRunningRepository?: boolean } = {}): string[] {
  const problems: string[] = [];
  let fromFile: string | undefined;
  try {
    fromFile = parseRepository(file);
  } catch (error) {
    return [(error as Error).message];
  }
  const variable = env['PUBLIC_REPOSITORY']?.trim();
  if (variable && variable !== fromFile) problems.push(`la variable PUBLIC_REPOSITORY (${variable}) diffère de .github/PUBLIC_REPOSITORY (${fromFile})`);
  const running = options.enforceRunningRepository === false ? undefined : env['GITHUB_REPOSITORY']?.trim();
  if (running && running !== (variable || fromFile)) {
    problems.push(`PUBLIC_REPOSITORY (${variable || fromFile}) doit égaler GITHUB_REPOSITORY (${running}) quand le travail tourne sur le dépôt public`);
  }
  return problems;
}
