// assert_deps_pinned : versions exactes, actions épinglées par SHA, lockfile gelé, permissions minimales (08b §5).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const ALLOWED_PROTOCOLS = /^(catalog:[\w-]*|workspace:\*)$/;

/** Une version de dépendance est valide si exacte, `catalog:` ou `workspace:*`. */
export function isPinnedVersion(spec: string): boolean {
  return EXACT.test(spec) || ALLOWED_PROTOCOLS.test(spec);
}

/** Versions du bloc `catalog:` / `catalogs:` de pnpm-workspace.yaml (lecture ligne à ligne, sans parseur YAML). */
export function checkCatalog(yaml: string): string[] {
  const problems: string[] = [];
  let inCatalog = false;
  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^\S/.test(line)) inCatalog = /^catalogs?:\s*$/.test(line);
    else if (inCatalog) {
      const match = /^\s+(?:'([^']+)'|"([^"]+)"|([^\s:]+)):\s*(\S.*)$/.exec(line);
      const name = match?.[1] ?? match?.[2] ?? match?.[3];
      const value = match?.[4]?.replace(/^['"]|['"]$/g, '');
      if (name !== undefined && value !== undefined && !isPinnedVersion(value)) {
        problems.push(`catalogue : ${name}: ${value} (version exacte attendue)`);
      }
    }
  }
  return problems;
}

export function checkPackageJson(label: string, json: string): string[] {
  const pkg = JSON.parse(json) as Record<string, Record<string, string> | undefined>;
  const problems: string[] = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (!isPinnedVersion(spec)) problems.push(`${label} : ${field}.${name}: ${spec} (version exacte attendue)`);
    }
  }
  return problems;
}

export function checkWorkflow(label: string, yaml: string): string[] {
  const problems: string[] = [];
  if (!/^permissions:/m.test(yaml)) problems.push(`${label} : bloc permissions: absent (contents: read minimal)`);
  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    const uses = /^\s*-?\s*uses:\s*(\S+)/.exec(line)?.[1];
    if (uses !== undefined && !uses.startsWith('./')) {
      const ok = uses.startsWith('docker://') ? /@sha256:[0-9a-f]{64}$/.test(uses) : /@[0-9a-f]{40}$/.test(uses);
      if (!ok) problems.push(`${label} : action non épinglée par SHA complet : ${uses}`);
    }
    const image = /^\s*image:\s*(\S+)/.exec(line)?.[1];
    if (image !== undefined && !/@sha256:[0-9a-f]{64}$/.test(image)) {
      problems.push(`${label} : image de service non épinglée par empreinte : ${image}`);
    }
    if (/\bpnpm install\b/.test(line) && !/--frozen-lockfile/.test(line)) {
      problems.push(`${label} : pnpm install sans --frozen-lockfile : ${raw.trim()}`);
    }
  }
  return problems;
}

export function checkDockerfile(label: string, text: string): string[] {
  const problems: string[] = [];
  for (const raw of text.split('\n')) {
    const arg = /^\s*ARG\s+\w*IMAGE\w*=(\S+)/.exec(raw)?.[1];
    const from = /^\s*FROM\s+(?:--\S+\s+)?([^\s$]+)/.exec(raw)?.[1];
    for (const image of [arg, from]) {
      if (image !== undefined && image !== 'scratch' && !/@sha256:[0-9a-f]{64}$/.test(image)) {
        problems.push(`${label} : image de base non épinglée par empreinte : ${image}`);
      }
    }
    if (/\bpnpm install\b/.test(raw) && !/--frozen-lockfile/.test(raw)) {
      problems.push(`${label} : pnpm install sans --frozen-lockfile : ${raw.trim()}`);
    }
  }
  return problems;
}

function tracked(root: string, pathspec: string[]): string[] {
  return execFileSync('git', ['ls-files', ...pathspec], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** Vérification réelle. `runtimeDir` = runtime/, la racine git en est le parent. */
export function checkRepo(runtimeDir: string): string[] {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: runtimeDir, encoding: 'utf8' }).trim();
  const problems: string[] = [];
  if (!existsSync(join(runtimeDir, 'pnpm-lock.yaml'))) problems.push('pnpm-lock.yaml absent');
  problems.push(...checkCatalog(readFileSync(join(runtimeDir, 'pnpm-workspace.yaml'), 'utf8')));
  for (const file of tracked(root, ['runtime/package.json', 'runtime/*/package.json', 'runtime/*/*/package.json'])) {
    problems.push(...checkPackageJson(file, readFileSync(join(root, file), 'utf8')));
  }
  for (const file of tracked(root, ['.github/workflows/*.yml', '.github/workflows/*.yaml'])) {
    problems.push(...checkWorkflow(file, readFileSync(join(root, file), 'utf8')));
  }
  for (const file of tracked(root, ['runtime/deploy/Dockerfile'])) {
    problems.push(...checkDockerfile(file, readFileSync(join(root, file), 'utf8')));
  }
  return problems;
}

if (import.meta.main) {
  const problems = checkRepo(new URL('..', import.meta.url).pathname);
  if (problems.length > 0) {
    console.error(`assert_deps_pinned :\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log('assert_deps_pinned : versions exactes, actions et images épinglées, lockfile gelé.');
}
