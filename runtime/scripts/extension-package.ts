// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.9 (07 § 7) : paquet de l'extension pour le Chrome Web Store (visibilité non listée). `pnpm package:extension`
// régénère les icônes, construit avec `wxt zip`, puis contrôle le zip produit (contenu, manifeste, code distant) et
// affiche son chemin, son empreinte SHA-256 et sa taille. La SOUMISSION au Store n'est pas faite ici : elle est humaine.
// `--json` : dernière ligne = rapport JSON. `--self-test` : vérifie que la grille de contrôle refuse bien les paquets fautifs.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const EXT = new URL('../apps/extension/', import.meta.url).pathname;
const DIST = join(EXT, 'dist');

/** Permissions fixes de 07 § 4 : toute addition passe en revue (et met à jour la fiche du Store). */
export const EXPECTED_PERMISSIONS = ['alarms', 'cookies', 'debugger', 'scripting', 'storage', 'tabGroups', 'tabs'] as const;
const ALLOWED_FILE = /^(manifest\.json|background\.js|popup\.html|chunks\/[\w.-]+\.(js|css)|assets\/[\w.-]+\.(css|woff2)|icons\/(16|32|48|128)\.png)$/;
const FORBIDDEN_KEYS = ['content_scripts', 'externally_connectable', 'web_accessible_resources', 'update_url', 'key', 'oauth2'];

type Manifest = Record<string, unknown> & { version?: string; permissions?: string[]; host_permissions?: string[]; optional_host_permissions?: string[]; icons?: Record<string, string> };

/** Problèmes d'un paquet : liste vide = propre. `read` rend le contenu d'un fichier du zip. */
export function auditPackage(files: string[], read: (file: string) => string, packageVersion: string): string[] {
  const problems: string[] = [];
  for (const f of files) if (!ALLOWED_FILE.test(f)) problems.push(`fichier hors paquet : ${f}`);
  if (!files.includes('manifest.json')) return [...problems, 'manifest.json absent de la racine du zip'];
  const manifest = JSON.parse(read('manifest.json')) as Manifest;
  if (manifest.version !== packageVersion) problems.push(`version du manifeste (${manifest.version}) ≠ package.json (${packageVersion})`);
  if (!/^\d{1,5}(\.\d{1,5}){0,3}$/.test(manifest.version ?? '') || !(manifest.version ?? '').split('.').some((n) => Number(n) > 0)) problems.push('version invalide pour Chrome');
  if (manifest.manifest_version !== 3) problems.push('manifest_version ≠ 3');
  const permissions = [...(manifest.permissions ?? [])].sort();
  if (JSON.stringify(permissions) !== JSON.stringify([...EXPECTED_PERMISSIONS])) problems.push(`permissions inattendues : ${permissions.join(', ')}`);
  if ((manifest.host_permissions ?? []).length > 0) problems.push('host_permissions non vide (les hôtes sont optionnels, assert_optional_hosts)');
  if (JSON.stringify(manifest).includes('<all_urls>')) problems.push('<all_urls> dans le manifeste');
  for (const key of FORBIDDEN_KEYS) if (key in manifest) problems.push(`clé de manifeste interdite : ${key}`);
  for (const size of ['16', '32', '48', '128']) {
    const icon = manifest.icons?.[size];
    if (icon === undefined || !files.includes(icon)) problems.push(`icône ${size} déclarée mais absente du zip`);
  }
  // Tâche 3.15 : feuille et polices du popup, servies par l'extension elle-même ; aucune ressource distante (polices comprises).
  for (const f of files.filter((n) => /\.css$/.test(n))) {
    if (/@import|url\(\s*["']?(https?:)?\/\//i.test(read(f))) problems.push(`ressource distante dans ${f}`);
  }
  for (const f of files.filter((n) => /\.(js|html)$/.test(n))) {
    const text = read(f);
    if (/\beval\s*\(|new\s+Function\s*\(/.test(text)) problems.push(`évaluation dynamique dans ${f}`);
    if (/<script[^>]+src\s*=\s*["']?(https?:)?\/\//i.test(text)) problems.push(`script distant dans ${f}`);
    if (/\bimport\s*\(\s*["']https?:/.test(text) || /\bimportScripts\s*\(\s*["']https?:/.test(text)) problems.push(`import distant dans ${f}`);
  }
  return problems;
}

function selfTest(): void {
  const good = ['manifest.json', 'background.js', 'popup.html', 'chunks/popup-abc.js', 'assets/popup-abc.css', 'assets/dm-sans-latin-400-normal-abc.woff2', 'icons/16.png', 'icons/32.png', 'icons/48.png', 'icons/128.png'];
  const manifest = {
    manifest_version: 3,
    version: '1.2.3',
    permissions: [...EXPECTED_PERMISSIONS],
    host_permissions: [],
    optional_host_permissions: ['https://*/*'],
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  };
  const reader = (m: unknown, extra: Record<string, string> = {}) => (f: string) => (f === 'manifest.json' ? JSON.stringify(m) : (extra[f] ?? ''));
  const cases: [string, string[], (f: string) => string, RegExp | null][] = [
    ['paquet propre', good, reader(manifest), null],
    ['<all_urls>', good, reader({ ...manifest, optional_host_permissions: ['<all_urls>'] }), /all_urls/],
    ['hôte statique', good, reader({ ...manifest, host_permissions: ['https://x.example/*'] }), /host_permissions/],
    ['permission en trop', good, reader({ ...manifest, permissions: [...EXPECTED_PERMISSIONS, 'history'] }), /permissions inattendues/],
    ['content script', good, reader({ ...manifest, content_scripts: [] }), /content_scripts/],
    ['eval', good, reader(manifest, { 'background.js': 'eval("1")' }), /évaluation dynamique/],
    ['police ou feuille distante', good, reader(manifest, { 'assets/popup-abc.css': '@import url(https://fonts.googleapis.com/css2?family=DM+Sans);' }), /ressource distante/],
    ['script distant', good, reader(manifest, { 'popup.html': '<script src="https://cdn.example/x.js"></script>' }), /script distant/],
    ['import distant', good, reader(manifest, { 'background.js': 'importScripts("https://cdn.example/x.js")' }), /import distant/],
    ['source map', [...good, 'background.js.map'], reader(manifest), /hors paquet/],
    ['icône absente', good.filter((f) => f !== 'icons/128.png'), reader(manifest), /icône 128/],
    ['version nulle', good, reader({ ...manifest, version: '0.0.0' }), /version invalide/],
  ];
  for (const [name, files, read, expected] of cases) {
    const problems = auditPackage(files, read, (JSON.parse(read('manifest.json')) as Manifest).version ?? '');
    const ok = expected === null ? problems.length === 0 : problems.some((p) => expected.test(p));
    if (!ok) {
      console.error(`auto-test en échec : ${name} → ${JSON.stringify(problems)}`);
      process.exit(1);
    }
  }
  console.log(`auto-test : ${cases.length} cas conformes`);
}

function run(cmd: string, args: string[], cwd: string): void {
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 2, 2] });
  if (r.status !== 0) {
    console.error(`échec : ${cmd} ${args.join(' ')} (code ${r.status ?? 'signal'})`);
    process.exit(r.status ?? 1);
  }
}

function main(): void {
  const json = process.argv.includes('--json');
  if (process.argv.includes('--self-test')) return selfTest();
  const version = (JSON.parse(readFileSync(join(EXT, 'package.json'), 'utf8')) as { version: string }).version;
  run('node', ['scripts/extension-icons.ts'], new URL('..', import.meta.url).pathname);
  run('pnpm', ['exec', 'wxt', 'zip'], EXT);
  const zips = readdirSync(DIST).filter((f) => /^scrapyomama-.*-chrome\.zip$/.test(f));
  const expected = `scrapyomama-${version}-chrome.zip`;
  if (zips.length !== 1 || zips[0] !== expected) {
    console.error(`zip attendu : ${expected} ; trouvé : ${zips.join(', ') || 'aucun'}`);
    process.exit(1);
  }
  const zip = join(DIST, expected);
  const list = spawnSync('unzip', ['-Z1', zip], { encoding: 'utf8' });
  if (list.status !== 0) {
    console.error(`unzip -Z1 : ${list.stderr}`);
    process.exit(1);
  }
  const files = list.stdout.split('\n').filter((f) => f !== '' && !f.endsWith('/'));
  const read = (f: string) => spawnSync('unzip', ['-p', zip, f], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout;
  const problems = auditPackage(files, read, version);
  if (problems.length > 0) {
    console.error(`paquet refusé :\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  const bytes = statSync(zip).size;
  const sha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
  const manifest = JSON.parse(read('manifest.json')) as Manifest;
  const report = { zip, sha256, bytes, files: files.sort(), version, permissions: manifest.permissions ?? [] };
  if (!json) console.log(`\npaquet propre : ${zip}\n  ${bytes} octets, sha256 ${sha256}, ${files.length} fichiers\n  À soumettre à la main au Chrome Web Store (visibilité non listée) : voir apps/extension/store/listing.md`);
  else console.log(JSON.stringify(report));
}

if (process.argv[1] === new URL(import.meta.url).pathname) main();
