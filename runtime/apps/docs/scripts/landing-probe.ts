// SPDX-License-Identifier: AGPL-3.0-only
// Sonde de la landing (22 § 2.9, 22b § 5) : rejoue sur une adresse les contrôles cookie, requêtes tierces, traceurs, CSP et
// formulaire. Avant le GO : sur la préproduction (le build de production servi en local comme GitHub Pages, sans déploiement) ;
// après : chaque semaine sur l'URL de production, échec = issue automatique, résultat daté archivé et cité par `#preuves`.
//   node scripts/landing-probe.ts --preprod            construit, sert en local sous /sym/, sonde, ne publie rien
//   node scripts/landing-probe.ts <https://hôte/sym/>  sonde une adresse déjà servie (production) ; lecture seule
// Options : --out <fichier> écrit le résultat daté en JSON. Code de sortie 1 si un contrôle échoue.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startPagesServer } from '../e2e/pages-server.ts';
import { evaluateProbes, probeReport } from '../src/landing/checks.ts';
import { HOME_PATHS, LEGAL_PATHS } from '../src/landing/href.ts';
import { probePages, withBrowser } from '../src/landing/probe.ts';

const docsDir = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : undefined;
const target = args.find((arg, index) => !arg.startsWith('--') && args[index - 1] !== '--out');
const preprod = args.includes('--preprod');
if (!preprod && !target) {
  console.error('usage : landing-probe.ts --preprod | <adresse du site, avec son chemin de base> [--out fichier]');
  process.exit(2);
}

let root = target ?? '';
let stop: (() => Promise<void>) | undefined;
if (preprod) {
  const build = spawnSync('node', ['scripts/build.ts'], { cwd: docsDir, stdio: 'inherit', env: { ...process.env, DOCS_BASE: '/sym/', DOCS_OUT_DIR: 'dist-preprod' } });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const server = await startPagesServer(fileURLToPath(new URL('../dist-preprod', import.meta.url)), '/sym/');
  root = server.url;
  stop = server.close;
}
const base = root.replace(/\/+$/, '');
const urls = [...Object.values(HOME_PATHS), ...Object.values(LEGAL_PATHS).flatMap((legal) => Object.values(legal))].map((path) => `${base}/${path}`);
try {
  const probes = await withBrowser((browser) => probePages(browser, urls));
  const report = probeReport(preprod ? 'preprod (build local servi comme GitHub Pages)' : base, evaluateProbes(probes));
  for (const check of report.checks) console.log(`${check.ok ? 'ok  ' : 'ECHEC'} ${check.name}${check.ok ? '' : `\n  - ${check.details.join('\n  - ')}`}`);
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await stop?.();
}
