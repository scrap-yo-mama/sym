// SPDX-License-Identifier: AGPL-3.0-only
// Hygiène du module SYM Browser (cdc/sym-browser 06 tâche 0.1) : environnement Claude (assert_module_claude_env, volet
// statique ; le volet interactif `/context` et `/permissions` se vérifie dans une session lancée ici), licences AGPL/MIT,
// en-têtes SPDX, versions par le catalogue, image non root avec tini et seccomp.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MODULE_ROOT } from '../eslint.boundaries.mjs';

const read = (file: string): string => readFileSync(join(MODULE_ROOT, file), 'utf8');
type Manifest = { name: string; license: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
const manifest = (dir: string): Manifest => JSON.parse(read(join(dir, 'package.json'))) as Manifest;

const REPO_ROOT = join(MODULE_ROOT, '../../..');
const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });

const PACKAGES = ['.', 'apps/gateway', 'apps/node', 'apps/console', 'packages/sdk', 'packages/core', 'packages/db'];
const MIT = new Set(['packages/sdk']);
const SKIP = new Set(['node_modules', 'dist', '.vite', 'coverage']);

function files(dir: string): string[] {
  return readdirSync(join(MODULE_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/** Licence attendue : champ `license` du package.json le plus proche dans le module. */
function licenseOf(file: string): string {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(MODULE_ROOT, dir, 'package.json'))) return manifest(dir).license;
    if (dir === '.') throw new Error(`aucun package.json pour ${file}`);
  }
}

describe('assert_module_claude_env (volet statique)', () => {
  test('CLAUDE.md du module : moins de 200 lignes, commandes citées existantes', () => {
    const claude = read('CLAUDE.md');
    expect(claude.split('\n').length).toBeLessThan(200);
    const scripts = new Map(PACKAGES.map((dir) => [manifest(dir).name, Object.keys(manifest(dir).scripts ?? {})]));
    const cited = [...claude.matchAll(/pnpm --filter (@[\w/-]+) ([\w:-]+)/g)];
    expect(cited.length).toBeGreaterThan(0);
    for (const [, name = '', script = ''] of cited) expect(scripts.get(name), `${name} ${script}`).toContain(script);
  });

  test('settings.json autonome : deny des garde-fous et mémoire propre au module', () => {
    const settings = JSON.parse(read('.claude/settings.json')) as { permissions: { deny: string[]; ask: string[] }; autoMemoryDirectory: string };
    expect(settings.autoMemoryDirectory).toBe('~/.claude-memory/scrapyomama-browser');
    for (const rule of ['Bash(git add -A:*)', 'Bash(git push --force:*)', 'Bash(git push -f:*)', 'Write(**/*.py)', 'Write(**/*.ipynb)', 'Read(**/.env)', 'Read(**/scraper.py)', 'Read(**/google_scraper.py)', 'Read(**/anticaptcha.py)']) {
      expect(settings.permissions.deny, rule).toContain(rule);
    }
    for (const rule of ['Bash(npm publish:*)', 'Bash(pnpm publish:*)', 'Bash(docker push:*)', 'Bash(git push:*)']) expect(settings.permissions.ask, rule).toContain(rule);
  });

  test('skills du module : SKILL.md avec nom et description', () => {
    const skills = readdirSync(join(MODULE_ROOT, '.claude/skills'));
    // 03-architecture § 9 : browser-parity (parité avec le pool navigateur de SYM, 04e § 5 et 04g § 5).
    expect(skills.sort()).toEqual(expect.arrayContaining(['browser-ci', 'browser-contract-change', 'browser-parity']));
    for (const skill of skills) {
      const text = read(`.claude/skills/${skill}/SKILL.md`);
      expect(text, skill).toMatch(new RegExp(`^---\\nname: ${skill}\\ndescription: .{20,}`));
    }
  });

  test('agent browser-dev à la racine du dépôt (.claude/agents/), suivi par git malgré /.claude/ ignoré', () => {
    const agent = join(MODULE_ROOT, '../../../.claude/agents/browser-dev.md');
    expect(readFileSync(agent, 'utf8')).toMatch(/^---\nname: browser-dev\ndescription: /);
    // /.claude/ est dans .gitignore : un « git add » ordinaire perdrait l'agent ; il doit rester dans l'index.
    expect(git('ls-files', '--', '.claude/agents/browser-dev.md').trim()).toBe('.claude/agents/browser-dev.md');
  });

  test('parité deny racine/module : la liste du module couvre celle de la racine dès qu’elle est versionnée (tâche 5.0)', () => {
    const own = JSON.parse(read('.claude/settings.json')) as { permissions: { deny: string[] } };
    // Jusqu'à 5.0, aucune .claude/settings.json versionnée à la racine : la liste du module est la référence.
    const tracked = git('ls-files', '--', '.claude/settings.json').trim();
    if (tracked === '') return;
    const root = JSON.parse(readFileSync(join(REPO_ROOT, tracked), 'utf8')) as { permissions?: { deny?: string[] } };
    expect((root.permissions?.deny ?? []).filter((rule) => !own.permissions.deny.includes(rule))).toEqual([]);
  });
});

describe('licences et en-têtes', () => {
  test('SDK en MIT, tout le reste en AGPL-3.0-only', () => {
    for (const dir of PACKAGES) expect(manifest(dir).license, dir).toBe(MIT.has(dir) ? 'MIT' : 'AGPL-3.0-only');
    expect(read('packages/sdk/LICENSE')).toMatch(/^MIT License\n/);
    expect(read('LICENSE')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
  });

  test('chaque source porte l’en-tête SPDX de la licence de son paquet', () => {
    const wrong: string[] = [];
    for (const file of files('.').filter((f) => /\.(ts|mts|mjs|vue)$/.test(f))) {
      const first = read(file).split('\n', 1)[0] ?? '';
      const found = /SPDX-License-Identifier: (\S+?)(?: -->)?$/.exec(first)?.[1];
      if (found !== licenseOf(file)) wrong.push(`${file} : ${found ?? 'absent'} au lieu de ${licenseOf(file)}`);
    }
    expect(wrong).toEqual([]);
  });
});

describe('versions et image', () => {
  test('dépendances déclarées : paquets du module, @sym/contracts, @runtime/ui ou npm tiers, jamais un autre paquet du dépôt', () => {
    const forbidden: string[] = [];
    for (const dir of PACKAGES) {
      const { dependencies = {}, devDependencies = {} } = manifest(dir);
      for (const name of Object.keys({ ...dependencies, ...devDependencies })) {
        const allowed = name.startsWith('@sym-browser/') || name === '@sym/contracts' || name === '@runtime/ui' || !/^@(runtime|sym)\//.test(name);
        if (!allowed) forbidden.push(`${dir} : ${name}`);
      }
    }
    expect(forbidden).toEqual([]);
  });

  test('dépendances par le catalogue (`catalog:`) ou le workspace (`workspace:*`), jamais une plage', () => {
    for (const dir of PACKAGES) {
      const { dependencies = {}, devDependencies = {} } = manifest(dir);
      for (const [name, spec] of Object.entries({ ...dependencies, ...devDependencies })) expect(spec, `${dir} ${name}`).toMatch(/^(catalog:|workspace:\*)$/);
    }
  });

  test('Dockerfile : base Playwright 1.63.0 épinglée par empreinte, non root, tini en PID 1', () => {
    const dockerfile = read('Dockerfile');
    const images = [...dockerfile.matchAll(/^ARG \w*IMAGE\w*=(\S+)$/gm)].map((m) => m[1] ?? '');
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/^mcr\.microsoft\.com\/playwright:v1\.63\.0-noble@sha256:[0-9a-f]{64}$/);
    const lastStage = dockerfile.split(/^FROM /m).at(-1) ?? '';
    const users = [...lastStage.matchAll(/^USER (\S+)$/gm)].map((m) => m[1]);
    expect(users.at(-1)).toBe('pwuser');
    expect(lastStage).toMatch(/^ENTRYPOINT \["\/usr\/bin\/tini", "--"\]$/m);
    expect(lastStage).toMatch(/apt-get install -y --no-install-recommends tini/);
    expect(dockerfile).not.toMatch(/--no-sandbox/);
    // Aucun binaire setuid ou setgid dans l'image d'exécution (su, mount, passwd…) : bits retirés au build.
    expect(lastStage).toMatch(/find \/ -xdev -perm \/6000 -type f -exec chmod a-s \{\} \+/);
  });

  test('docker run documenté et rejoué : seccomp, no-new-privileges et --cap-drop ALL', () => {
    const runs = [read('CLAUDE.md'), read('Dockerfile')].flatMap((text) => text.split('\n').filter((line) => /docker run /.test(line)));
    expect(runs.length).toBeGreaterThan(0);
    for (const line of runs) {
      expect(line).toContain('--security-opt seccomp=modules/browser/deploy/seccomp-chromium.json');
      expect(line).toContain('--security-opt no-new-privileges');
      expect(line).toContain('--cap-drop ALL');
    }
  });

  test('profil seccomp de Chromium : copie exacte de celui de SYM, refus par défaut', () => {
    const copy = read('deploy/seccomp-chromium.json');
    // Une dérive entre les deux copies doit casser la CI : la mise à jour se fait des deux côtés à la fois.
    expect(copy).toBe(readFileSync(join(MODULE_ROOT, '../../deploy/seccomp-chromium.json'), 'utf8'));
    const profile = JSON.parse(copy) as { defaultAction: string; syscalls: unknown[] };
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
    expect(profile.syscalls.length).toBeGreaterThan(0);
  });

  test('aucun fichier Python ni notebook dans le module (X6)', () => {
    expect(files('.').filter((f) => /\.(py|pyc|ipynb)$/.test(f)).map((f) => relative('.', f))).toEqual([]);
  });
});
