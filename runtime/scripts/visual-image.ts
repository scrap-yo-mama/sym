// SPDX-License-Identifier: AGPL-3.0-only
// Régression visuelle par langue sous linux (assert_visual_regression_by_locale, part de 3.6 confiée à 3.17) : joue les projets
// ui-en, ui-fr et ui-pseudo de la console dans l'image Playwright épinglée par empreinte de deploy/Dockerfile (même Chromium,
// mêmes polices de secours d'un poste à l'autre, CI comprise). Le dossier runtime/ est monté en lecture seule et copié dans le
// conteneur sans node_modules ni builds ; les dépendances de la console y sont installées (lockfile figé, magasin pnpm dans un
// volume Docker local), ses paquets construits, puis la suite visuelle jouée.
//   pnpm visual:image            compare aux instantanés de apps/web/e2e/__visual__/linux (CI posée : une référence absente échoue)
//   pnpm visual:image --update   (ré)écrit ces instantanés, à relire avant de les committer
// Durée bornée (D-88) : SYM_VISUAL_TIMEOUT_MS (25 min par défaut) ; à l'expiration, le conteneur sym-visual-<pid> est supprimé.
// Aucun site réel : la console est servie en boucle locale par le faux serveur d'API de apps/web/e2e/harness.ts. Rien n'est
// publié, aucune image n'est construite ni poussée.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBoundedContainer, visualContainerName, visualTimeoutMs } from './visual-image-bound.ts';

const runtimeDir = new URL('..', import.meta.url).pathname;
const dockerfile = readFileSync(join(runtimeDir, 'deploy/Dockerfile'), 'utf8');
const image = /^ARG PLAYWRIGHT_IMAGE=(\S+@sha256:[0-9a-f]{64})$/m.exec(dockerfile)?.[1];
if (image === undefined) {
  console.error('visual:image : image Playwright épinglée introuvable dans deploy/Dockerfile (ARG PLAYWRIGHT_IMAGE=…@sha256:…).');
  process.exit(1);
}

const update = process.argv.includes('--update');
const outDir = mkdtempSync(join(tmpdir(), 'sym-visual-'));
const EXCLUDED = ['node_modules', 'dist', 'coverage', 'test-results', 'blob-report', 'playwright-report', '.wxt', '.output', '.vitepress/cache', '.vitepress/dist', '*.tsbuildinfo'];
const inner = [
  'set -eu',
  'mkdir -p /work',
  `tar -C /src ${EXCLUDED.map((name) => `--exclude=${name}`).join(' ')} -cf - . | tar -C /work -xf -`,
  'cd /work',
  'corepack enable >/dev/null',
  'pnpm install --frozen-lockfile --filter "@runtime/web..." --store-dir /pnpm-store --reporter=append-only',
  'pnpm --filter "@runtime/web^..." build',
  'cd apps/web',
  `status=0; pnpm exec playwright test --project ui-en --project ui-fr --project ui-pseudo${update ? ' --update-snapshots=all' : ''} || status=$?`,
  update ? 'cp -R e2e/__visual__/linux /out/linux' : 'true',
  'if [ -d test-results ]; then cp -R test-results /out/test-results; fi',
  'exit $status',
].join('\n');

// La sous-commande `run` et le nom du conteneur sont posés par runBoundedContainer (borne de durée, D-88).
const args = [
  '--rm',
  '--init',
  '-e', 'SYM_VISUAL_IMAGE=1',
  '-e', 'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
  // Comparaison : CI posée, une référence absente échoue au lieu d'être écrite (e2e/visual-policy.ts).
  ...(update ? [] : ['-e', 'CI=1']),
  '-v', `${runtimeDir}:/src:ro`,
  '-v', `${outDir}:/out`,
  '-v', 'sym-visual-pnpm-store:/pnpm-store',
  image,
  'bash', '-c', inner,
];
console.log(`visual:image : ${update ? 'mise à jour' : 'comparaison'} des instantanés linux dans ${image}`);
// Borne de durée (D-88) : conteneur nommé, supprimé de force à l'expiration (SYM_VISUAL_TIMEOUT_MS, 25 min par défaut).
const { status } = runBoundedContainer(spawnSync, args, { name: visualContainerName(process.pid), timeoutMs: visualTimeoutMs(process.env) });

if (update && status === 0) {
  const target = join(runtimeDir, 'apps/web/e2e/__visual__/linux');
  if (!existsSync(join(outDir, 'linux'))) {
    console.error('visual:image : aucun instantané produit.');
    process.exit(1);
  }
  rmSync(target, { recursive: true, force: true });
  cpSync(join(outDir, 'linux'), target, { recursive: true });
  console.log(`visual:image : instantanés écrits dans ${target} ; relisez-les avant de les committer.`);
}
if (status !== 0 && existsSync(join(outDir, 'test-results'))) console.error(`visual:image : écarts et captures dans ${join(outDir, 'test-results')}`);
if (status === 0) rmSync(outDir, { recursive: true, force: true });
process.exit(status);
