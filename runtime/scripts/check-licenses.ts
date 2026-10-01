// SPDX-License-Identifier: AGPL-3.0-only
// assert_licenses_compatible : scan des licences installées (`pnpm licenses list --json`) contre une liste
// autorisée compatible avec l'AGPL-3.0 du cœur (08b §5). Licence inconnue ou interdite : échec.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIT_PACKAGES } from './spdx-headers.ts';

export const ALLOWED = new Set([
  'MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'MPL-2.0',
  'CC0-1.0', 'Unlicense',
  'Python-2.0', // texte de licence seul (argparse) : aucun code Python livré (X6)
  'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'GPL-2.0-or-later', 'GPL-3.0-only', 'GPL-3.0-or-later', 'AGPL-3.0-only', 'AGPL-3.0-or-later',
]);

/** Licences explicitement refusées (source-available, non libres, propriétaires). */
export const FORBIDDEN = /^(SSPL|BUSL|BSL-1|Commons[- ]Clause|Elastic|Proprietary|UNLICENSED|SEE LICENSE|GPL-2\.0(-only)?$)/i;

/** Exceptions par nom de paquet, chacune justifiée. Vide aujourd'hui. */
export const EXCEPTIONS: Record<string, string> = {
  // 'paquet': 'raison, licence réelle vérifiée à la main, date',
};

type Verdict = 'allowed' | 'forbidden' | 'unknown';

/** Évalue une expression SPDX simple : `A OR B` (un choix suffit), `A AND B` (tout doit passer). */
export function classify(expression: string): Verdict {
  const expr = expression.trim().replace(/^\((.*)\)$/, '$1');
  const orBranches = expr.split(/\s+OR\s+/);
  if (orBranches.length > 1) {
    const verdicts = orBranches.map(classify);
    return verdicts.includes('allowed') ? 'allowed' : verdicts.includes('forbidden') ? 'forbidden' : 'unknown';
  }
  const andParts = expr.split(/\s+AND\s+/);
  if (andParts.length > 1) {
    const verdicts = andParts.map(classify);
    return verdicts.includes('forbidden') ? 'forbidden' : verdicts.every((v) => v === 'allowed') ? 'allowed' : 'unknown';
  }
  if (FORBIDDEN.test(expr)) return 'forbidden';
  return ALLOWED.has(expr) ? 'allowed' : 'unknown';
}

type Report = Record<string, { name: string; versions: string[] }[]>;

export function evaluate(report: Report, exceptions: Record<string, string> = EXCEPTIONS): string[] {
  const problems: string[] = [];
  for (const [license, packages] of Object.entries(report)) {
    const verdict = classify(license);
    if (verdict === 'allowed') continue;
    for (const pkg of packages) {
      if (pkg.name in exceptions) continue;
      problems.push(`${pkg.name}@${pkg.versions.join(',')} : licence ${verdict === 'forbidden' ? 'interdite' : 'inconnue'} (${license})`);
    }
  }
  return problems;
}

// --- Contrôle PAR PAQUET (D-10, 16 §1) : `client` et `schemas` sont publiés en MIT. Aucune dépendance de production, directe ou
// transitive, ne doit être sous licence à copyleft (une licence virale sur ce qu'on insère chez les clients freine
// l'adoption), et aucune ne doit être un paquet AGPL du workspace. Le scan global ci-dessus accepte (L)GPL et AGPL pour
// le cœur : ce contrôle-ci est plus strict.

/** Licences permissives, seules acceptées sous un paquet MIT. */
const PERMISSIVE = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0']);
/** Copyleft, fort ou faible (famille GPL, MPL, EPL, CDDL, EUPL, OSL, CC-BY-SA, SSPL, CPAL). */
const COPYLEFT = /^(A?GPL|LGPL|MPL|EPL|CDDL|EUPL|OSL|CC-BY-SA|SSPL|CPAL|CPL|RPL|Sleepycat)/i;

export function classifyForMit(expression: string): Verdict {
  const expr = expression.trim().replace(/^\((.*)\)$/, '$1');
  const or = expr.split(/\s+OR\s+/);
  if (or.length > 1) {
    const verdicts = or.map(classifyForMit);
    return verdicts.includes('allowed') ? 'allowed' : verdicts.includes('forbidden') ? 'forbidden' : 'unknown';
  }
  const and = expr.split(/\s+AND\s+/);
  if (and.length > 1) {
    const verdicts = and.map(classifyForMit);
    return verdicts.includes('forbidden') ? 'forbidden' : verdicts.every((v) => v === 'allowed') ? 'allowed' : 'unknown';
  }
  const bare = expr.replace(/\+$/, '').replace(/-(only|or-later)$/, '');
  if (COPYLEFT.test(bare) || FORBIDDEN.test(expr)) return 'forbidden';
  return PERMISSIVE.has(expr) ? 'allowed' : 'unknown';
}

type PackageManifest = { name?: string; license?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

/**
 * Problèmes d'un paquet MIT : licence déclarée, dépendances de production vers un paquet du workspace non MIT, et
 * licences des dépendances installées (`report` = `pnpm licenses list --json --prod --filter <paquet>`).
 */
export function evaluateMitPackage(label: string, manifest: PackageManifest, report: Report, mitNames: ReadonlySet<string>, exceptions: Record<string, string> = EXCEPTIONS): string[] {
  const problems: string[] = [];
  if (manifest.license !== 'MIT') problems.push(`${label} : licence déclarée « ${manifest.license ?? '(absente)'} », MIT attendu`);
  const declared = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies };
  for (const [name, spec] of Object.entries(declared)) {
    if ((name.startsWith('@runtime/') || spec.startsWith('workspace:')) && !mitNames.has(name)) {
      problems.push(`${label} : dépend du paquet du workspace ${name}, qui n'est pas MIT (le cœur est AGPL-3.0)`);
    }
  }
  for (const [license, packages] of Object.entries(report)) {
    if (classifyForMit(license) === 'allowed') continue;
    for (const pkg of packages) {
      if (pkg.name in exceptions) continue;
      problems.push(`${label} : dépendance ${pkg.name}@${pkg.versions.join(',')} sous licence ${classifyForMit(license) === 'forbidden' ? 'à copyleft ou interdite' : 'inconnue'} (${license})`);
    }
  }
  return problems;
}

/** `pnpm licenses` écrit un texte (pas du JSON) quand le paquet n'a aucune dépendance : rapport vide. */
export function parseLicenseReport(output: string): Report {
  const text = output.trim();
  return text.startsWith('{') ? (JSON.parse(text) as Report) : {};
}

function pnpmLicenses(runtimeDir: string, args: string[]): Report {
  return parseLicenseReport(execFileSync('pnpm', ['licenses', 'list', '--json', ...args], { cwd: runtimeDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

/** Contrôle réel de chaque paquet MIT du dépôt. */
export function checkMitPackages(runtimeDir: string, licensesOf: (name: string) => Report = (name) => pnpmLicenses(runtimeDir, ['--prod', '--filter', name])): string[] {
  const manifests = MIT_PACKAGES.map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(runtimeDir, dir, 'package.json'), 'utf8')) as PackageManifest }));
  const mitNames = new Set(manifests.map((m) => m.manifest.name ?? ''));
  return manifests.flatMap(({ dir, manifest }) => evaluateMitPackage(dir, manifest, licensesOf(manifest.name ?? dir), mitNames));
}

if (import.meta.main) {
  const out = execFileSync('pnpm', ['licenses', 'list', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const report = JSON.parse(out) as Report;
  const problems = [...evaluate(report), ...checkMitPackages(new URL('..', import.meta.url).pathname)];
  if (problems.length > 0) {
    console.error(`assert_licenses_compatible :\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  const count = Object.values(report).reduce((n, list) => n + list.length, 0);
  console.log(`assert_licenses_compatible : ${count} paquets, toutes licences compatibles AGPL-3.0 ; ${MIT_PACKAGES.join(' et ')} (MIT) sans dépendance à copyleft.`);
}
