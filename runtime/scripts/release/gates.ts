// SPDX-License-Identifier: AGPL-3.0-only
// assert_release_gates : linter des workflows et de l'image de release (08b §5, 14 §6). Sans parseur YAML (lecture ligne
// à ligne, comme check-deps-pinned.ts) : les workflows du dépôt restent simples.
//   - tout workflow : actions épinglées par SHA, permissions minimales (check-deps-pinned), pas de `pull_request_target`
//     qui exécute du code de PR, pas de donnée de PR interpolée dans un script (`run:`) ;
//   - workflow de release : déclenché par étiquette seulement, environnement à relecteurs, aucun cache, permissions
//     d'écriture au niveau du job, signature + SBOM + provenance présents ;
//   - image : conteneur non root (assert_image_nonroot).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkWorkflow } from '../check-deps-pinned.ts';

const strip = (raw: string) => raw.replace(/\s+#.*$/, '');

/** Entrées de `on:` (clés de premier niveau du bloc, ou liste en ligne). */
function triggers(yaml: string): { events: string[]; tagFilter: boolean; branchFilter: boolean } {
  const lines = yaml.split('\n').map(strip);
  const start = lines.findIndex((l) => /^on:/.test(l));
  if (start < 0) return { events: [], tagFilter: false, branchFilter: false };
  const inline = /^on:\s*(.+)$/.exec(lines[start] ?? '')?.[1];
  if (inline !== undefined) return { events: inline.replace(/[[\]\s]/g, '').split(',').filter(Boolean), tagFilter: false, branchFilter: false };
  const block: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break;
    block.push(l);
  }
  const events = block.map((l) => /^ {2}([\w-]+):/.exec(l)?.[1]).filter((e): e is string => e !== undefined);
  const text = block.join('\n');
  return { events, tagFilter: /^\s+tags:/m.test(text), branchFilter: /^\s+branches:/m.test(text) };
}

/** Données d'un événement qu'un tiers choisit (titre de PR, branche, corps) : jamais dans un `run:`. */
const UNTRUSTED = /\$\{\{\s*(github\.event\.(pull_request|issue|comment|review|head_commit|commits|pages|workflow_run)\b|github\.head_ref)[^}]*\}\}/;

export function checkWorkflowSecurity(label: string, yaml: string): string[] {
  const problems = checkWorkflow(label, yaml);
  const { events } = triggers(yaml);
  const lines = yaml.split('\n').map(strip);
  if (events.includes('pull_request_target')) {
    const runsCode = lines.some((l) => /^\s*-?\s*run:/.test(l));
    const checkoutRef = lines.some((l) => /^\s+(ref|repository):.*(pull_request|head_ref|head\.)/.test(l));
    if (runsCode || checkoutRef) problems.push(`${label} : pull_request_target exécute du code (run: ou extraction de la PR) : interdit`);
  }
  // Interpolation de données de tiers dans un script : seule la ligne `run:` et ses lignes de continuation comptent.
  let inRun = false;
  let runIndent = 0;
  for (const line of lines) {
    const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
    const run = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(line);
    if (run) {
      inRun = true;
      runIndent = run[1]?.length ?? 0;
      if (UNTRUSTED.test(run[2] ?? '')) problems.push(`${label} : donnée de tiers interpolée dans un script : ${line.trim()}`);
    } else if (inRun && line.trim() !== '' && indent > runIndent) {
      if (UNTRUSTED.test(line)) problems.push(`${label} : donnée de tiers interpolée dans un script : ${line.trim()}`);
    } else if (line.trim() !== '') inRun = false;
  }
  return problems;
}

/** Un workflow qui publie : étiquette seule, environnement, aucun cache, signature, SBOM, provenance. */
export function checkReleaseWorkflow(label: string, yaml: string): string[] {
  const problems = checkWorkflowSecurity(label, yaml);
  const { events, tagFilter, branchFilter } = triggers(yaml);
  const lines = yaml.split('\n').map(strip);
  const text = lines.join('\n');
  if (!events.includes('push') || !tagFilter || branchFilter || events.some((e) => e !== 'push')) {
    problems.push(`${label} : la release se déclenche par étiquette seulement (push: tags:, ni branche, ni pull_request, ni déclenchement manuel)`);
  }
  if (!/^\s+environment:\s*\S+/m.test(text)) problems.push(`${label} : aucun environnement (environment:) : les relecteurs de l'environnement doivent approuver la release`);
  if (/uses:\s*actions\/cache\b|^\s+cache(-from|-to)?:|^\s+cache-dependency-path:|--cache-(from|to)/m.test(text)) {
    problems.push(`${label} : aucun cache dans le workflow de release (empoisonnement de cache)`);
  }
  const top = /^permissions:\n((?:[ \t]+.*\n?|\n)*)/m.exec(`${text}\n`)?.[1] ?? '';
  if (/\bwrite\b/.test(top)) problems.push(`${label} : permissions d'écriture au niveau du workflow : à déclarer au niveau du job`);
  if (!/^\s+id-token:\s*write/m.test(text)) problems.push(`${label} : id-token: write absent (signature sans clé)`);
  if (/^\s+(ref|tags?):.*latest\b/m.test(text) || /:latest\b/.test(text)) problems.push(`${label} : tag « latest » interdit`);
  const checkouts = lines.reduce((n, l) => n + (/uses:\s*actions\/checkout@/.test(l) ? 1 : 0), 0);
  const noPersist = lines.reduce((n, l) => n + (/^\s+persist-credentials:\s*false/.test(l) ? 1 : 0), 0);
  if (checkouts > noPersist) problems.push(`${label} : actions/checkout sans persist-credentials: false`);
  if (!/cosign sign\b/.test(text) || !/cosign sign-blob\b/.test(text)) problems.push(`${label} : signature cosign (image et fichiers) absente`);
  if (!/cosign attest\b/.test(text) || !/cyclonedx/i.test(text)) problems.push(`${label} : SBOM CycloneDX attesté (cosign attest) absent`);
  if (!/attest-build-provenance@/.test(text)) problems.push(`${label} : attestation de provenance absente`);
  return problems;
}

/** Dernier stage du Dockerfile : `USER` non root (nom autre que root, ou uid différent de 0). */
export function checkImageNonRoot(label: string, dockerfile: string): string[] {
  const stages = dockerfile.split(/^\s*FROM\s/m).slice(1);
  const last = stages[stages.length - 1] ?? '';
  const users = [...last.matchAll(/^\s*USER\s+(\S+)/gm)].map((m) => m[1] ?? '');
  const user = users[users.length - 1];
  if (user === undefined || /^(root|0)(:|$)/.test(user)) return [`${label} : l'image finale tourne en root (USER non-root attendu)`];
  return [];
}

/** Garde réelle : tous les workflows, le workflow de release s'il existe, le Dockerfile. */
export function checkRepo(root: string): string[] {
  const repo = join(root, '..');
  const dir = join(repo, '.github/workflows');
  const problems: string[] = [];
  const releaseFile = 'release.yml';
  if (!existsSync(join(dir, releaseFile))) problems.push(`.github/workflows/${releaseFile} : workflow de release absent`);
  for (const name of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const yaml = readFileSync(join(dir, name), 'utf8');
    problems.push(...(name === releaseFile ? checkReleaseWorkflow : checkWorkflowSecurity)(`.github/workflows/${name}`, yaml));
  }
  problems.push(...checkImageNonRoot('deploy/Dockerfile', readFileSync(join(root, 'deploy/Dockerfile'), 'utf8')));
  return problems;
}

if (import.meta.main) {
  const problems = checkRepo(new URL('../..', import.meta.url).pathname);
  if (problems.length > 0) {
    console.error(`assert_release_gates :\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log('assert_release_gates : workflows épinglés, release par étiquette, environnement, sans cache, signature + SBOM + provenance, image non root.');
}
