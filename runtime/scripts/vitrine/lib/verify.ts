// SPDX-License-Identifier: AGPL-3.0-only
// Bloc « Verify what you download » (22 §3.1, u8 R15) et étiquettes OCI de l'image (22 §3.4, u8 R16), dérivés de l'identité publique.
import { spawnSync } from 'node:child_process';
import { certificateIdentity, OIDC_ISSUER, type PublicIdentity } from './identity.ts';
import { userVerifyCommand } from '../../release/sign.ts';

export type ParsedVerify = { cosignImage: string; certificateIdentity: string; oidcIssuer: string; attestationRef: string; attestationRepo: string; checksum: string };

/** Lit les trois commandes du bloc. */
export function parseVerifyBlock(block: string): ParsedVerify | undefined {
  const flat = block.replace(/\s*\\\n\s*/g, ' ');
  const cosign = /^cosign verify (\S+) --certificate-identity=(\S+) --certificate-oidc-issuer=(\S+)$/m.exec(flat);
  const attest = /^gh attestation verify (oci:\/\/\S+) -R (\S+)$/m.exec(flat);
  const checksum = /^(sha256sum -c \S+)$/m.exec(flat);
  if (!cosign || !attest || !checksum) return undefined;
  return { cosignImage: cosign[1] ?? '', certificateIdentity: cosign[2] ?? '', oidcIssuer: cosign[3] ?? '', attestationRef: attest[1] ?? '', attestationRepo: attest[2] ?? '', checksum: checksum[1] ?? '' };
}

/**
 * `assert_verify_snippet_works`, partie hors réseau : le bloc dit exactement ce que la chaîne de release (4.9) produit
 * pour ce dépôt, cette image et cette étiquette. `cosign verify` sans clé et `gh attestation verify` ne se jouent que
 * contre une image publiée (GO) : ce contrôle garde leur identité, leur émetteur et leur dépôt.
 */
export function verifySnippetProblems(block: string, identity: PublicIdentity, version = 'X.Y.Z'): string[] {
  const parsed = parseVerifyBlock(block);
  if (!parsed) return ['le bloc « Verify » n\'a pas la forme attendue (cosign verify, gh attestation verify, sha256sum -c)'];
  const problems: string[] = [];
  const tag = `v${version}`;
  const release = userVerifyCommand(identity.repository, tag, `${identity.image}:${version}`);
  const releaseIdentity = /--certificate-identity (\S+)/.exec(release)?.[1];
  if (parsed.certificateIdentity !== releaseIdentity) problems.push(`identité du certificat ${parsed.certificateIdentity} ≠ celle de la release (${releaseIdentity})`);
  if (parsed.certificateIdentity !== certificateIdentity(identity, tag)) problems.push('identité du certificat non dérivée de PUBLIC_REPOSITORY');
  if (parsed.oidcIssuer !== OIDC_ISSUER || !release.includes(`--certificate-oidc-issuer ${parsed.oidcIssuer}`)) problems.push(`émetteur OIDC ${parsed.oidcIssuer} ≠ celui de la release`);
  if (parsed.cosignImage !== `${identity.image}:${version}`) problems.push(`image ${parsed.cosignImage} ≠ ${identity.image}:${version}`);
  if (parsed.attestationRef !== `oci://${identity.image}:${version}` || parsed.attestationRepo !== identity.repository) problems.push('gh attestation verify : image ou dépôt ≠ identité publique');
  return problems;
}

/** Joue `sha256sum -c SHA256SUMS` dans `dir` (`shasum -a 256 -c` si `sha256sum` manque, comme sur macOS). */
export function checksumResult(dir: string): { ok: boolean; output: string } {
  const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, encoding: 'utf8' });
  let result = run('sha256sum', ['-c', 'SHA256SUMS']);
  if (result.error) result = run('shasum', ['-a', '256', '-c', 'SHA256SUMS']);
  return { ok: result.status === 0, output: `${result.stdout}${result.stderr}`.trim() };
}

/** Étiquettes OCI attendues de l'image (22 §3.4), dérivées de l'identité publique. */
function expectedLabels(identity: PublicIdentity, description: string): Record<string, string> {
  return {
    'org.opencontainers.image.source': identity.url,
    'org.opencontainers.image.description': description,
    'org.opencontainers.image.licenses': 'AGPL-3.0-only',
    'io.modelcontextprotocol.server.name': identity.mcpName,
  };
}

/** `assert_image_labels` : étiquettes lues sur l'image (ou sur le Dockerfile) comparées aux étiquettes attendues. */
export function imageLabelProblems(labels: Record<string, string>, identity: PublicIdentity, description: string): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(expectedLabels(identity, description))) {
    if (labels[key] === undefined) problems.push(`étiquette ${key} absente`);
    else if (labels[key] !== value) problems.push(`étiquette ${key} = « ${labels[key]} » (attendu « ${value} »)`);
  }
  const text = labels['org.opencontainers.image.description'] ?? '';
  if (text.length > 512) problems.push(`description de ${text.length} caractères (512 au plus)`);
  if (labels['org.opencontainers.image.source'] !== `https://github.com/${identity.repository}`) problems.push('source ≠ https://github.com/ + PUBLIC_REPOSITORY');
  if (labels['io.modelcontextprotocol.server.name'] !== `io.github.${identity.owner}/${identity.name}`) problems.push('nom MCP ≠ io.github.<propriétaire>/<dépôt>');
  return problems;
}

/**
 * Étiquettes déclarées par le Dockerfile (dernier stage), `ARG PUBLIC_REPOSITORY` résolu avec `repository`.
 * Lecture statique : la construction réelle est contrôlée par le test d'image.
 */
export function dockerfileLabels(dockerfile: string, repository: string): Record<string, string> {
  const last = dockerfile.split(/^FROM /m).pop() ?? '';
  const args: Record<string, string> = {};
  for (const m of last.matchAll(/^ARG (\w+)(?:=(.*))?$/gm)) args[m[1] ?? ''] = (m[2] ?? '').replace(/^"|"$/g, '');
  args['PUBLIC_REPOSITORY'] = repository;
  // `${NOM}` et `${NOM:+mot}` (mot seulement si NOM est non vide), comme le Dockerfile.
  const expand = (value: string): string =>
    value.replace(/\$\{(\w+)(?::\+([^}]*))?\}/g, (_m, name: string, word: string | undefined) => (word === undefined ? (args[name] ?? '') : args[name] ? word : ''));
  const labels: Record<string, string> = {};
  const block = /^LABEL ((?:.*\\\n)*.*)$/m.exec(last)?.[1] ?? '';
  for (const m of block.replace(/\s*\\\n\s*/g, ' ').matchAll(/([\w.-]+)="([^"]*)"/g)) labels[m[1] ?? ''] = expand(m[2] ?? '');
  return labels;
}

