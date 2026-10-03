// SPDX-License-Identifier: AGPL-3.0-only
// Préproduction de la landing : le build de production du commit (DOCS_BASE=/sym/, sortie à part dans dist-preprod) servi par un
// serveur statique local qui reproduit GitHub Pages. Rien n'est publié ni déployé. L'adresse est passée aux tests par l'environnement.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withBuildLock } from '../src/testing/build-lock.ts';
import { startPagesServer, type PagesServer } from './pages-server.ts';

const docsDir = fileURLToPath(new URL('..', import.meta.url));
export const PREPROD_DIST = fileURLToPath(new URL('../dist-preprod', import.meta.url));

export default async function globalSetup(): Promise<() => Promise<void>> {
  const build = await withBuildLock(docsDir, () => spawnSync('node', ['scripts/build.ts'], { cwd: docsDir, encoding: 'utf8', timeout: 300_000, env: { ...process.env, DOCS_BASE: '/sym/', DOCS_OUT_DIR: 'dist-preprod' } }));
  if (build.status !== 0) throw new Error(`construction de la préproduction échouée (code ${build.status}) :\n${build.stdout}${build.stderr}`);
  const server: PagesServer = await startPagesServer(PREPROD_DIST, '/sym/');
  process.env['LANDING_PREPROD_URL'] = server.url;
  return () => server.close();
}
