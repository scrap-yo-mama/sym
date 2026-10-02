// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 5.0 (étape 0 de l'architecture modulaire) : la carte des modules (docs/modules.md) couvre tous les dossiers de
// apps/* et packages/*, les CLAUDE.md restent courts et ne citent que des commandes qui existent, et le rapport de
// frontières dependency-cruiser du nightly est publié sans jamais bloquer. Contrôles STATIQUES : rien n'est exécuté.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const runtimeDir = new URL('..', import.meta.url).pathname;
const repoDir = join(runtimeDir, '..');
const read = (path: string) => readFileSync(path, 'utf8');
const json = <T>(path: string): T => JSON.parse(read(path)) as T;

type PackageJson = { name?: string; scripts?: Record<string, string>; devDependencies?: Record<string, string> };

/** Dossiers de apps/* et packages/* (un dossier avec package.json = un paquet de l'espace de travail). */
function workspaceDirs(): string[] {
  return ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(runtimeDir, group), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(runtimeDir, group, e.name, 'package.json')))
      .map((e) => `${group}/${e.name}`),
  );
}

/**
 * Dépôt de travail privé ou miroir public (D-44) : le miroir `scrap-yo-mama/sym` ne publie que runtime/, .github/ et quelques
 * fichiers de la racine. La carte (docs/modules.md) et le CLAUDE.md racine n'y sont pas : leurs contrôles sont sautés là-bas
 * (saut visible), jamais en erreur à la collecte. Même motif que apps/web/src/i18n/reasons.unit.test.ts.
 */
const PRIVATE = existsSync(join(repoDir, 'docs/modules.md'));
const ROOT_CLAUDE = join(repoDir, 'CLAUDE.md');

/** Le CLAUDE.md racine (commandes de runtime/package.json, dépôt de travail seulement) et ceux des dossiers de l'étape 0. */
const STEP0_FOLDERS = ['apps/extension', 'apps/web', 'apps/docs', 'packages/agent', 'packages/llm', 'packages/ui'];
const claudeFiles = [
  ...(PRIVATE ? [{ path: ROOT_CLAUDE, pkgDir: runtimeDir }] : []),
  ...STEP0_FOLDERS.map((d) => ({ path: join(runtimeDir, d, 'CLAUDE.md'), pkgDir: join(runtimeDir, d) })),
];

/** Sous-commandes de pnpm qui ne sont pas des scripts du package.json. */
const PNPM_BUILTINS = new Set(['install', 'i', 'add', 'exec', 'dlx', 'remove', 'update', 'store', 'why', 'list', 'ls']);

/** `pnpm [--filter <paquet>] <script> …` cité entre apostrophes inverses : renvoie les scripts à retrouver dans un package.json. */
function citedPnpmScripts(markdown: string): { filter?: string; script: string; raw: string }[] {
  const out: { filter?: string; script: string; raw: string }[] = [];
  for (const [, span] of markdown.matchAll(/`(pnpm [^`]+)`/g)) {
    // Un span peut chaîner plusieurs commandes : `pnpm a, pnpm b` est découpé par les virgules des tableaux.
    for (const part of span!.split(/\s*(?:&&|;)\s*/)) {
      const tokens = part.trim().split(/\s+/).slice(1);
      let filter: string | undefined;
      if (tokens[0] === '--filter' || tokens[0] === '-F') {
        filter = tokens[1];
        tokens.splice(0, 2);
      }
      if (tokens[0] === 'run') tokens.shift();
      const script = tokens[0];
      if (!script || script.startsWith('-') || script.startsWith('<') || PNPM_BUILTINS.has(script)) continue;
      out.push({ filter, script, raw: part.trim() });
    }
  }
  return out;
}

function packagesByName(): Map<string, PackageJson & { dir: string }> {
  const map = new Map<string, PackageJson & { dir: string }>();
  for (const dir of [...workspaceDirs(), 'fixtures']) {
    const pkg = json<PackageJson>(join(runtimeDir, dir, 'package.json'));
    if (pkg.name) map.set(pkg.name, { ...pkg, dir });
  }
  return map;
}

/** Lignes d'une table Markdown dont la première cellule est `runtime/<dossier>`. */
const tableRow = (markdown: string, dir: string) => markdown.split('\n').find((line) => line.startsWith(`| \`runtime/${dir}\` |`));

describe.skipIf(!PRIVATE)('assert_module_map_complete : carte des modules, dépôt de travail (tâche 5.0)', () => {
  // Lu seulement dans le dépôt de travail : le corps d'un describe sauté est quand même collecté.
  const modulesMd = PRIVATE ? read(join(repoDir, 'docs/modules.md')) : '';

  test('chaque dossier de runtime/apps/* et runtime/packages/* apparaît dans docs/modules.md, rattaché à une partie', () => {
    const dirs = workspaceDirs();
    expect(dirs.length).toBeGreaterThanOrEqual(13);
    for (const dir of dirs) {
      const row = modulesMd.split('\n').find((line) => line.startsWith(`| \`runtime/${dir}\` |`) && line.includes('Thomas'));
      expect(row, `${dir} absent de la table « Dossier par dossier » de docs/modules.md`).toBeDefined();
      expect(row, dir).toMatch(/\| (Core \+ Runner|Brain|Browser|Extension|Front) \|/);
    }
    // Les cinq parties sont nommées.
    for (const part of ['Core + Runner', 'Brain', 'Browser', 'Extension', 'Front']) expect(modulesMd).toContain(`**${part}**`);
  });

  test('un dossier de la carte qui n existe pas est détecté (la carte ne cite pas de dossier fantôme)', () => {
    const dirs = new Set(workspaceDirs());
    const cited = [...modulesMd.matchAll(/`runtime\/((?:apps|packages)\/[a-z0-9-]+)`/g)].map((m) => m[1]!);
    expect(cited.length).toBeGreaterThan(0);
    for (const dir of cited) expect(dirs.has(dir), `${dir} cité dans docs/modules.md mais absent de runtime/`).toBe(true);
  });

  test('Front = apps/web, apps/docs, packages/ui (23 § 2) ; packages/client reste dans Core + Runner, producteur du contrat api', () => {
    const parts = modulesMd.split('\n').filter((line) => line.startsWith('| **'));
    const front = parts.find((line) => line.startsWith('| **Front**'))!;
    const core = parts.find((line) => line.startsWith('| **Core + Runner**'))!;
    const frontDirs = [...front.matchAll(/`runtime\/((?:apps|packages)\/[a-z0-9-]+)`/g)].map((m) => m[1]).sort();
    expect(frontDirs).toEqual(['apps/docs', 'apps/web', 'packages/ui']);
    expect(core).toContain('`runtime/packages/client`');
    const client = tableRow(modulesMd, 'packages/client');
    expect(client).toMatch(/\| Core \+ Runner \|/);
    expect(client).toMatch(/contrat `api`/);
    expect(client).toMatch(/Front/);
  });

  test('la carte liste les sous-chemins publics de @runtime/core importables par un module (23 § 2), et seulement des exports réels', () => {
    const start = modulesMd.indexOf('## Sous-chemins publics de `@runtime/core` importables par un module');
    expect(start, 'section « Sous-chemins publics de @runtime/core importables par un module » absente').toBeGreaterThan(-1);
    const end = modulesMd.indexOf('\n## ', start + 1);
    const section = modulesMd.slice(start, end === -1 ? undefined : end);
    // Les quatre domaines nommés par 23 § 2.
    for (const domain of ['config', 'chiffrement', 'journaux', 'garde réseau']) expect(section).toContain(domain);
    // Chaque sous-chemin cité existe dans les exports de @runtime/core, et chaque export y est classé (importable ou réservé).
    const exportsMap = json<{ exports: Record<string, unknown> }>(join(runtimeDir, 'packages/core/package.json')).exports;
    const exported = Object.keys(exportsMap).filter((k) => k !== '.').map((k) => k.slice(2));
    const cited = [...section.matchAll(/`@runtime\/core\/([a-z0-9-]+)`/g)].map((m) => m[1]!);
    for (const sub of cited) expect(exported, `@runtime/core/${sub} cité mais absent des exports`).toContain(sub);
    for (const sub of exported) expect(cited, `@runtime/core/${sub} exporté mais non classé dans la carte`).toContain(sub);
  });

  test('le CLAUDE.md racine nomme exactement les dossiers de runtime/ qui ont leur propre CLAUDE.md', () => {
    const onDisk = workspaceDirs().filter((dir) => existsSync(join(runtimeDir, dir, 'CLAUDE.md'))).sort();
    expect(onDisk).toEqual([...STEP0_FOLDERS].sort());
    const root = read(ROOT_CLAUDE).replace(/\s+/g, ' ');
    expect(root).not.toMatch(/chaque dossier de module a son propre/);
    const sentence = root.match(/les dossiers ([^.]*?) ont leur propre `CLAUDE\.md`/);
    expect(sentence, 'phrase « les dossiers … ont leur propre CLAUDE.md » absente du CLAUDE.md racine').not.toBeNull();
    const named = [...sentence![1]!.matchAll(/`((?:apps|packages)\/[a-z0-9-]+)`/g)].map((m) => m[1]).sort();
    expect(named).toEqual(onDisk);
  });
});

describe('assert_module_map_complete : CLAUDE.md de dossier (tâche 5.0, publiés par le miroir)', () => {
  test.each(claudeFiles.map((f) => [f.path.replace(repoDir + '/', ''), f] as const))('%s : moins de 200 lignes, commandes pnpm existantes', (_name, file) => {
    expect(existsSync(file.path), `${file.path} manquant`).toBe(true);
    const text = read(file.path);
    expect(text.split('\n').length).toBeLessThan(200);

    const byName = packagesByName();
    const own = json<PackageJson>(join(file.pkgDir, 'package.json'));
    const rootPackage = json<PackageJson>(join(runtimeDir, 'package.json'));
    const cited = citedPnpmScripts(text);
    for (const { filter, script, raw } of cited) {
      // Avec --filter : le paquet nommé. Sans : le package.json du dossier ; un CLAUDE.md de dossier peut aussi citer une commande
      // lancée « depuis runtime/ », donc un script de runtime/package.json.
      const candidates = filter ? [byName.get(filter)] : file.pkgDir === runtimeDir ? [own] : [own, rootPackage];
      expect(candidates.every((c) => c === undefined), `« ${raw} » : paquet ${filter} introuvable`).toBe(false);
      const scripts = candidates.flatMap((c) => Object.keys(c?.scripts ?? {}));
      expect(scripts, `« ${raw} » : script « ${script} » absent du package.json`).toContain(script);
    }
    // Un CLAUDE.md de dossier cite au moins une commande de test qui existe.
    if (file.pkgDir !== runtimeDir) expect(cited.some((c) => c.script === 'test')).toBe(true);
  });

  test('l extracteur de commandes lit --filter, run et ignore les sous-commandes natives de pnpm', () => {
    const found = citedPnpmScripts('`pnpm install --frozen-lockfile` `pnpm --filter @runtime/web test` `pnpm run lint` `pnpm exec vitest run` `pnpm inconnu`');
    expect(found.map((c) => [c.filter, c.script])).toEqual([
      ['@runtime/web', 'test'],
      [undefined, 'lint'],
      [undefined, 'inconnu'],
    ]);
  });

  test('un CLAUDE.md publié (runtime/) qui renvoie à la carte ou au CLAUDE.md racine précise « du dépôt de travail » : ni l un ni l autre n est publié', () => {
    for (const dir of STEP0_FOLDERS) {
      const text = read(join(runtimeDir, dir, 'CLAUDE.md')).replace(/\s+/g, ' ');
      const dangling = [...text.matchAll(/`docs\/modules\.md`|`CLAUDE\.md` racine/g)].filter(
        (m) => !/^ (\(dépôt de travail|du dépôt de travail)/.test(text.slice(m.index! + m[0].length)),
      );
      expect(dangling.map((m) => m[0]), `${dir}/CLAUDE.md`).toEqual([]);
    }
  });
});

describe('assert_depcruise_report_published : dependency-cruiser du nightly, en rapport seulement (tâche 5.0)', () => {
  type Step = { name?: string; uses?: string; run?: string; if?: string; 'continue-on-error'?: boolean | string; with?: Record<string, string> };
  type Workflow = { on: Record<string, unknown>; jobs: Record<string, { 'continue-on-error'?: boolean | string; steps: Step[] }> };
  const workflow = parse(read(join(repoDir, '.github/workflows/nightly.yml'))) as Workflow;
  const jobEntry = Object.entries(workflow.jobs).find(([, job]) => job.steps.some((s) => s.run?.includes('depcruise')));

  test('une étape depcruise existe et ne bloque pas le job (continue-on-error)', () => {
    expect(jobEntry, 'aucune étape depcruise dans nightly.yml').toBeDefined();
    const [, job] = jobEntry!;
    expect(job['continue-on-error']).not.toBe(false);
    const step = job.steps.find((s) => s.run?.includes('depcruise'))!;
    expect(step['continue-on-error']).toBe(true);
    expect(step.run).toContain('.dependency-cruiser.cjs');
  });

  test('le rapport est publié : résumé du job et artefact, même si l étape échoue', () => {
    const [, job] = jobEntry!;
    const index = job.steps.findIndex((s) => s.run?.includes('depcruise'));
    expect(job.steps[index]!.run).toContain('$GITHUB_STEP_SUMMARY');
    const upload = job.steps.slice(index + 1).find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload, 'aucun upload-artifact après l étape depcruise').toBeDefined();
    expect(upload!.if).toContain('always()');
    expect(upload!.with?.path).toContain('reports');
    // Un rapport non produit (étape en échec avant l écriture) se voit dans le run : avertissement, pas un silence.
    expect(upload!.with?.['if-no-files-found']).toBe('warn');
    // Le fichier que l étape écrit est bien dans le dossier publié.
    expect(job.steps[index]!.run).toMatch(/--output-to reports\/dependency-cruiser\.(html|md)/);
  });

  test('tant que nightly.yml n a pas de cron, la note de l invariant le dit (rapport publié à chaque déclenchement manuel)', () => {
    const note = json<{ test: string; note: string }[]>(join(runtimeDir, 'tests/invariants.json')).find((r) => r.test === 'assert_depcruise_report_published')!.note;
    if (!('schedule' in workflow.on)) {
      expect(note).toContain('workflow_dispatch');
      expect(note).toMatch(/chaque nuit dès que le cron est activé/);
    }
  });

  test('packages/client (Core + Runner, MIT) n est pas du Front ; règle dédiée : il n importe que @runtime/schemas', () => {
    type Rule = { name: string; from: { path: string }; to: { path: string } };
    const config = createRequire(import.meta.url)(join(runtimeDir, '.dependency-cruiser.cjs')) as { forbidden: Rule[] };
    const rule = (name: string) => config.forbidden.find((r) => r.name === name)!;
    expect(new RegExp(rule('front-pas-serveur').from.path).test('packages/client/src/index.ts')).toBe(false);
    for (const front of ['apps/web/src/main.ts', 'apps/docs/src/x.ts', 'packages/ui/src/index.ts'])
      expect(new RegExp(rule('front-pas-serveur').from.path).test(front), front).toBe(true);
    const client = rule('client-schemas-seulement');
    expect(client, 'règle client-schemas-seulement absente').toBeDefined();
    expect(new RegExp(client.from.path).test('packages/client/src/index.ts')).toBe(true);
    const to = new RegExp(client.to.path);
    for (const target of ['@runtime/core', 'packages/core/src/index.ts', '@runtime/db', '@runtime/ui', 'apps/server/src/app.ts', '@runtime/agent'])
      expect(to.test(target), target).toBe(true);
    for (const allowed of ['@runtime/schemas', 'packages/schemas/src/index.ts', 'node_modules/openapi-fetch/dist/index.js'])
      expect(to.test(allowed), allowed).toBe(false);
  });

  test('la configuration encode les frontières en warn seulement ; dépendance au catalogue en version exacte', () => {
    const config = createRequire(import.meta.url)(join(runtimeDir, '.dependency-cruiser.cjs')) as { forbidden: { name: string; severity: string }[] };
    const names = config.forbidden.map((r) => r.name);
    for (const name of ['front-pas-serveur', 'extension-pas-worker', 'brain-pas-runner']) expect(names).toContain(name);
    for (const rule of config.forbidden) expect(rule.severity, rule.name).toBe('warn');

    const catalog = parse(read(join(runtimeDir, 'pnpm-workspace.yaml'))) as { catalog: Record<string, string> };
    expect(catalog.catalog['dependency-cruiser']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(json<PackageJson>(join(runtimeDir, 'package.json')).devDependencies?.['dependency-cruiser']).toBe('catalog:');
  });
});
