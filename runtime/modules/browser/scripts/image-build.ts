// SPDX-License-Identifier: AGPL-3.0-only
// Image multi-arch de SYM Browser (cdc/sym-browser 03 § 9, 04f § 8 ; tâche 5.1) : linux/amd64 et linux/arm64, une seule
// construction buildx, nom ghcr.io/scrap-yo-mama/sym-browser. Par défaut, archive OCI locale : RIEN n'est publié.
// La publication (tâche 5.7, ⚠️ GO de l'utilisateur) exige `--push` ET SYMB_PUBLISH_GO=oui ; signature, SBOM et provenance
// arrivent avec la chaîne de release (tâche 5.4).
// Usage, depuis runtime/ :
//   node modules/browser/scripts/image-build.ts --version 1.0.0 [--out /tmp/sym-browser.oci.tar]
// L'étape arm64 demande l'émulation QEMU (binfmt) sur une machine amd64 ; le build JavaScript tourne sur la plateforme hôte.
import { spawnSync } from 'node:child_process';

export const IMAGE_NAME = 'ghcr.io/scrap-yo-mama/sym-browser';
export const IMAGE_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

export type ImageBuildOptions = { version: string; push: boolean; env: Readonly<Record<string, string | undefined>>; out?: string };

/** Commande `docker buildx build` (sans l'exécuter). Étiquettes : x.y.z, puis x.y et x hors préversion. */
export function imageBuildCommand(options: ImageBuildOptions): string[] {
  const match = SEMVER.exec(options.version);
  if (!match) throw new Error(`version invalide : « ${options.version} » (x.y.z attendu, jamais latest).`);
  if (options.push && options.env.SYMB_PUBLISH_GO !== 'oui') {
    throw new Error('publication refusée : --push exige le GO explicite de l’utilisateur (SYMB_PUBLISH_GO=oui, tâche 5.7).');
  }
  const [, major, minor, , pre] = match;
  const tags = [options.version, ...(pre === undefined ? [`${major}.${minor}`, `${major}`] : [])].flatMap((tag) => ['--tag', `${IMAGE_NAME}:${tag}`]);
  const output = options.push ? ['--push'] : ['--output', `type=oci,dest=${options.out ?? `sym-browser-${options.version}.oci.tar`}`];
  return ['docker', 'buildx', 'build', '--platform', IMAGE_PLATFORMS.join(','), '-f', 'modules/browser/Dockerfile', ...tags, '--label', `org.opencontainers.image.version=${options.version}`, ...output, '.'];
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const value = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  try {
    const command = imageBuildCommand({ version: value('--version') ?? '', push: argv.includes('--push'), env: process.env, ...(value('--out') ? { out: value('--out')! } : {}) });
    console.log(command.join(' '));
    const [bin = 'docker', ...args] = command;
    const result = spawnSync(bin, args, { cwd: new URL('../../..', import.meta.url).pathname, stdio: 'inherit' });
    process.exit(result.status ?? 1);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
