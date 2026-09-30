// Liste noire INV6 : échoue si une dépendance (directe ou transitive, lue dans pnpm-lock.yaml) porte un nom
// de la liste de refus. Ce fichier ne contient que des NOMS à refuser (exclusions X1 à X3, cdc/.../_exclusions.md).
import { readFileSync } from 'node:fs';

export const DENY_PATTERNS = [
  'puppeteer-extra',
  'puppeteer-extra-*',
  'playwright-extra',
  'playwright-extra-*',
  '*stealth*',
  '*captcha*',
  '*capsolver*',
  'undetected-*',
  '*antidetect*',
  '*anti-detect*',
  'fingerprint-injector',
  'fingerprint-generator',
  'fingerprint-suite',
  'rebrowser-*',
  'patchright*',
  'camoufox*',
  'flaresolverr*',
  'cloudscraper*',
];

const toRegExp = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
const DENY = DENY_PATTERNS.map(toRegExp);

/** Noms de paquets du lockfile (sections packages et snapshots, pnpm v9 : `name@version:`). */
export function lockfilePackageNames(lockfile: string): Set<string> {
  const names = new Set<string>();
  let section = '';
  for (const line of lockfile.split('\n')) {
    if (/^\S/.test(line)) section = line.replace(/:.*/, '');
    else if ((section === 'packages' || section === 'snapshots') && /^ {2}\S/.test(line)) {
      const key = line.trim().replace(/:$/, '').replace(/^['"]|['"]$/g, '');
      const at = key.indexOf('@', 1);
      names.add(at === -1 ? key : key.slice(0, at));
    } else if (section === 'importers' && /^ {6}\S.*:$/.test(line)) {
      names.add(line.trim().replace(/:$/, '').replace(/^['"]|['"]$/g, ''));
    }
  }
  return names;
}

export function findDenied(lockfile: string): string[] {
  return [...lockfilePackageNames(lockfile)].filter((name) => DENY.some((re) => re.test(name))).sort();
}

if (import.meta.main) {
  const path = process.argv[2] ?? new URL('../pnpm-lock.yaml', import.meta.url).pathname;
  const denied = findDenied(readFileSync(path, 'utf8'));
  if (denied.length > 0) {
    console.error(`Liste noire INV6 : dépendances refusées dans ${path} :\n${denied.map((d) => `  - ${d}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Liste noire INV6 : aucune dépendance refusée.');
}
