// SPDX-License-Identifier: AGPL-3.0-only
// assert_release_gates : linter des workflows et de l'image de release (08b §5, 14 §6). Sans parseur YAML (lecture ligne
// à ligne, comme check-deps-pinned.ts) : les workflows du dépôt restent simples.
//   - tout workflow : actions épinglées par SHA, permissions minimales (check-deps-pinned), pas de `pull_request_target`
//     qui exécute du code de PR, pas de donnée de PR interpolée dans un script (`run:`) ;
//   - workflow de release : déclenché par étiquette seulement, environnement à relecteurs, aucun cache, permissions
//     d'écriture au niveau du job, signature + SBOM + provenance présents ;
//   - configurations release-please : chaque version calculée tombe dans son canal (stable, ou beta X.Y.Z-beta.N) ;
//   - tout job qui lit l'historique git (test unitaire X6, audit X6, release à blanc) : fetch-depth: 0 (assert_ci_full_history) ;
//   - image : conteneur non root (assert_image_nonroot).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkWorkflow } from '../check-deps-pinned.ts';
import { checkReleasePleaseConfigs } from './release-please.ts';

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

/**
 * Un script qui lit l'historique git entier : le test unitaire X6 sur le dépôt réel (pnpm test, test:coverage, test:fast,
 * vitest sur le projet unit), l'audit X6 de l'historique, la release à blanc. Sur un clone superficiel (actions/checkout
 * par défaut, profondeur 1), checkHistory refuse exprès : le job échouerait sur chaque PR.
 */
function readsHistory(script: string): boolean {
  if (/\bpnpm\s+(?:run\s+)?(?:test|test:coverage|test:fast|check:x6-history|release:dry-run)(?![\w:-])/.test(script)) return true;
  if (/check-x6\.ts\s+--history\b|release\/dry-run\.ts\b/.test(script)) return true;
  if (!/\bvitest\s+run\b/.test(script)) return false;
  const projects = [...script.matchAll(/--project[=\s]+(\S+)/g)].map((m) => m[1]);
  return projects.length === 0 || projects.includes('unit');
}

/** Tout job dont un script lit l'historique git (readsHistory) extrait tout l'historique : fetch-depth: 0 à chaque checkout. */
export function checkFullHistoryJobs(label: string, yaml: string): string[] {
  const lines = yaml.split('\n').map(strip);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs: { name: string; lines: string[] }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const job = /^ {2}([\w-]+):/.exec(line)?.[1];
    if (job !== undefined) jobs.push({ name: job, lines: [] });
    else jobs[jobs.length - 1]?.lines.push(line);
  }
  const problems: string[] = [];
  for (const job of jobs) {
    // Seuls les scripts comptent (ligne run: et ses lignes de continuation), pas le nom d'une étape.
    const scripts: string[] = [];
    let inRun = false;
    let runIndent = 0;
    for (const line of job.lines) {
      const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
      const run = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(line);
      if (run) {
        inRun = true;
        runIndent = run[1]?.length ?? 0;
        scripts.push(run[2] ?? '');
      } else if (inRun && line.trim() !== '' && indent > runIndent) scripts.push(line);
      else if (line.trim() !== '') inRun = false;
    }
    if (!scripts.some(readsHistory)) continue;
    const checkouts = job.lines.filter((l) => /uses:\s*actions\/checkout@/.test(l)).length;
    const deep = job.lines.filter((l) => /^\s+fetch-depth:\s*0\s*$/.test(l)).length;
    if (checkouts > deep) problems.push(`${label} : job « ${job.name} » : il lit l'historique git (test unitaire X6, audit de l'historique ou release à blanc) mais actions/checkout n'a pas fetch-depth: 0 (clone superficiel : échec garanti)`);
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
  // X6 (_exclusions, 08b §5) : l'historique git est audité avant chaque release publique ; il faut donc l'extraire en entier.
  if (!/^\s+fetch-depth:\s*0\s*$/m.test(text)) problems.push(`${label} : actions/checkout sans fetch-depth: 0 (l'audit X6 de l'historique exige tout l'historique)`);
  if (!/check:x6-history\b|check-x6\.ts --history\b/.test(text)) problems.push(`${label} : audit X6 de l'historique git absent (pnpm check:x6-history)`);
  // Outils épinglés : la version vérifiée en CI est celle de la release.
  const pinnedWith = (action: RegExp, input: string) => {
    const uses = lines.filter((l) => action.test(l)).length;
    const pins = lines.filter((l) => new RegExp(`^\\s+${input}:\\s*v\\d+\\.\\d+\\.\\d+\\s*$`).test(l)).length;
    return uses <= pins;
  };
  if (!pinnedWith(/uses:\s*sigstore\/cosign-installer@/, 'cosign-release')) problems.push(`${label} : cosign-installer sans cosign-release: vX.Y.Z (version de cosign non épinglée)`);
  if (!pinnedWith(/uses:\s*anchore\/sbom-action\/download-syft@/, 'syft-version')) problems.push(`${label} : download-syft sans syft-version: vX.Y.Z (version de syft non épinglée)`);
  // SBOM de l'image : CycloneDX 1.7 demandé explicitement (08b §5), puis validé comme celui du lockfile.
  if (/download-syft@/.test(text) && (!/cyclonedx-json@1\.7=/.test(text) || !/sbom\.ts --image\b/.test(text))) {
    problems.push(`${label} : SBOM de l'image non épinglé en CycloneDX 1.7 (cyclonedx-json@1.7) ou non validé (scripts/release/sbom.ts --image)`);
  }
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
    problems.push(...checkFullHistoryJobs(`.github/workflows/${name}`, yaml));
  }
  problems.push(...checkReleasePleaseConfigs(repo));
  problems.push(...checkImageNonRoot('deploy/Dockerfile', readFileSync(join(root, 'deploy/Dockerfile'), 'utf8')));
  return problems;
}

if (import.meta.main) {
  const problems = checkRepo(new URL('../..', import.meta.url).pathname);
  if (problems.length > 0) {
    console.error(`assert_release_gates :\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log('assert_release_gates : workflows épinglés, release par étiquette, environnement, sans cache, historique complet audité (X6) et extrait par chaque job qui le lit, outils épinglés, signature + SBOM 1.7 + provenance, canaux release-please, image non root.');
}
