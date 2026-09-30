// SPDX-License-Identifier: AGPL-3.0-only
// assert_licenses_compatible : scan des licences installées (`pnpm licenses list --json`) contre une liste
// autorisée compatible avec l'AGPL-3.0 du cœur (08b §5). Licence inconnue ou interdite : échec.
import { execFileSync } from 'node:child_process';

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

if (import.meta.main) {
  const out = execFileSync('pnpm', ['licenses', 'list', '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const report = JSON.parse(out) as Report;
  const problems = evaluate(report);
  if (problems.length > 0) {
    console.error(`assert_licenses_compatible :\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  const count = Object.values(report).reduce((n, list) => n + list.length, 0);
  console.log(`assert_licenses_compatible : ${count} paquets, toutes licences compatibles AGPL-3.0.`);
}
