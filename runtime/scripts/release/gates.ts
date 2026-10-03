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

/** Jobs d'un workflow : lignes du job et scripts (ligne `run:` et ses lignes de continuation, pas le nom d'une étape). */
function workflowJobs(yaml: string): { name: string; lines: string[]; scripts: string[] }[] {
  const lines = yaml.split('\n').map(strip);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [];
  const jobs: { name: string; lines: string[]; scripts: string[] }[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const job = /^ {2}([\w-]+):/.exec(line)?.[1];
    if (job !== undefined) jobs.push({ name: job, lines: [], scripts: [] });
    else jobs[jobs.length - 1]?.lines.push(line);
  }
  for (const job of jobs) {
    let inRun = false;
    let runIndent = 0;
    for (const line of job.lines) {
      const indent = /^(\s*)/.exec(line)?.[1]?.length ?? 0;
      const run = /^(\s*(?:-\s+)?)run:\s*(.*)$/.exec(line);
      if (run) {
        inRun = true;
        runIndent = run[1]?.length ?? 0;
        job.scripts.push(run[2] ?? '');
      } else if (inRun && line.trim() !== '' && indent > runIndent) job.scripts.push(line);
      else if (line.trim() !== '') inRun = false;
    }
  }
  return jobs;
}

/** Tout job dont un script lit l'historique git (readsHistory) extrait tout l'historique : fetch-depth: 0 à chaque checkout. */
export function checkFullHistoryJobs(label: string, yaml: string): string[] {
  const problems: string[] = [];
  for (const job of workflowJobs(yaml)) {
    if (!job.scripts.some(readsHistory)) continue;
    const checkouts = job.lines.filter((l) => /uses:\s*actions\/checkout@/.test(l)).length;
    const deep = job.lines.filter((l) => /^\s+fetch-depth:\s*0\s*$/.test(l)).length;
    if (checkouts > deep) problems.push(`${label} : job « ${job.name} » : il lit l'historique git (test unitaire X6, audit de l'historique ou release à blanc) mais actions/checkout n'a pas fetch-depth: 0 (clone superficiel : échec garanti)`);
  }
  return problems;
}

/**
 * assert_sandbox_image_privileges en CI (revue de F-20261001-R01) : un job de ci.yml joue le test de l'image construite
 * (`pnpm test:image`, seule preuve sur l'image du modèle de privilèges), à chaque PR (pas de condition `if:` au niveau du
 * job) et sans relance (`--retry=0`) : une régression du point d'entrée ou du Dockerfile ne passe pas la CI de fusion.
 */
export function checkCiImageJob(label: string, yaml: string): string[] {
  const runs = workflowJobs(yaml).filter((job) => job.scripts.some((l) => /\bpnpm\s+(?:run\s+)?test:image(?![\w:-])/.test(l)));
  const ok = runs.filter((job) => !job.lines.some((l) => /^ {4}if:/.test(l)) && job.scripts.some((l) => /\btest:image\b.*--retry=0\b/.test(l)));
  if (ok.length > 0) return [];
  return [`${label} : aucun job ne joue \`pnpm test:image --retry=0\` à chaque PR (privilèges du bac à sable sur l'image construite, assert_sandbox_image_privileges)`];
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

/** Seules capacités admises dans la descente : tout retirer, puis au plus cap_setuid et cap_setgid (rôle worker). */
const DROP_CAPS = /^--(?:inh|ambient)-caps=-all(?:,\+setuid)?(?:,\+setgid)?$/;
/** Autres options admises après `--reuid=<n> --regid=<n>` (ni autre identité, ni --bounding-set, ni --securebits). */
const DROP_FLAGS = new Set(['--init-groups', '--clear-groups', '--no-new-privs']);
/** Variables qui détourneraient ce que le shell root exécute (résolution des commandes, découpage, fichiers lus, chargeur). */
const DANGEROUS_ASSIGNMENT = /^(?:PATH|IFS|ENV|BASH_ENV|BASH_\w+|SHELLOPTS|BASHOPTS|PS4|LD_\w+)$/;

/**
 * Descente de privilèges du point d'entrée (deploy/entrypoint.sh, interprété par bash : `$EUID` n'existe pas ailleurs) :
 * sa première instruction (hors `set -eux`/`-o pipefail` et affectations littérales sans danger) est le bloc
 * `if [ "$EUID" = 0 ]; then … fi`, qui se termine par `exec /usr/bin/setpriv --reuid=<non nul> --regid=<non nul> <options> --
 * <commande>` et n'exécute rien d'autre. Options admises : `--init-groups`, `--clear-groups`, `--no-new-privs` (exigée),
 * `--inh-caps`/`--ambient-caps` à `-all` suivi au plus de `+setuid,+setgid`, et `"${t[@]}"` pour un tableau défini dans le
 * bloc dont chaque élément est une telle option de capacités. Toute autre option d'identité (`--reuid` répété, `--euid`,
 * `--groups`, `--keep-groups`…), `--bounding-set`, `--securebits` : refus. `undefined` si la descente est bien faite.
 */
function rootDropProblem(entrypoint: string): string | undefined {
  const OPEN = 'if [ "$EUID" = 0 ]; then';
  if (!/^#!\/bin\/bash[ \t]*(\n|$)/.test(entrypoint)) return "interpréteur autre que #!/bin/bash ($EUID n'existe qu'en bash : la descente sauterait)";
  const lines = entrypoint.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  // Avant le bloc : options du shell (ni -a ni allexport, qui exporteraient les affectations) et affectations littérales.
  const before = (l: string) => {
    if (/^set -(?=[eux]|o pipefail)[eux]*(?:o pipefail)?$/.test(l)) return true;
    const assignment = /^([A-Za-z_]\w*)=[^$`\s;&|()]*$/.exec(l);
    return assignment !== null && !DANGEROUS_ASSIGNMENT.test(assignment[1] ?? '');
  };
  const start = lines.findIndex((l) => !before(l));
  if (lines[start] !== OPEN) return `première instruction autre que la descente en root (${OPEN}) : ${lines[start] ?? 'aucune'}`;
  let depth = 0;
  let end = -1;
  for (let i = start; i < lines.length && end < 0; i++) {
    if (/^if\s/.test(lines[i] ?? '')) depth++;
    if (lines[i] === 'fi' && --depth === 0) end = i;
  }
  if (end < 0) return 'bloc root non fermé';
  const body = lines.slice(start + 1, end);
  // Dans le bloc, avant la descente : tableaux d'options de capacités et conditions sur des tests `[ … ]` seulement.
  const arrays = new Set<string>();
  for (const l of body.slice(0, -1)) {
    const array = /^([A-Za-z_]\w*)=\(([^$`;&|()]*)\)$/.exec(l);
    if (array !== null) {
      const bad = (array[2] ?? '').trim().split(/\s+/).find((opt) => !DROP_CAPS.test(opt));
      if (bad !== undefined) return `option refusée dans le tableau ${array[1] ?? ''} : ${bad} (capacités -all, puis au plus +setuid,+setgid)`;
      arrays.add(array[1] ?? '');
      continue;
    }
    if (/^(?:if (?:\[ [^\]`()]* \]|&&|\|\||[{};]|\s)+then|fi)$/.test(l)) continue;
    return `instruction exécutée en root avant la descente : ${l}`;
  }
  const drop = /^exec \/usr\/bin\/setpriv ((?:\S+ )*?)-- (\S[^;&|`()]*)$/.exec(body[body.length - 1] ?? '');
  if (drop === null) return 'le bloc root doit finir par exec /usr/bin/setpriv --reuid=… --regid=… --no-new-privs … -- … (chemin absolu)';
  const [uid, gid, ...rest] = (drop[1] ?? '').trim().split(/\s+/);
  const reuid = /^--reuid=(\d+)$/.exec(uid ?? '')?.[1];
  const regid = /^--regid=(\d+)$/.exec(gid ?? '')?.[1];
  if (reuid === undefined || regid === undefined) return 'la descente commence par --reuid=<uid> --regid=<gid>';
  if (Number(reuid) === 0 || Number(regid) === 0) return 'la descente vise root (uid ou gid 0)';
  for (const opt of rest) {
    if (DROP_FLAGS.has(opt) || DROP_CAPS.test(opt)) continue;
    const expanded = /^"\$\{([A-Za-z_]\w*)\[@\]\}"$/.exec(opt)?.[1];
    if (expanded !== undefined && arrays.has(expanded)) continue;
    return `option refusée dans la descente : ${opt} (une seule identité, capacités -all puis au plus +setuid,+setgid)`;
  }
  if (!rest.includes('--no-new-privs')) return 'la descente doit poser --no-new-privs';
  return undefined;
}

/**
 * Dernier stage du Dockerfile : aucun processus ne reste root. `USER` non root (nom autre que root, ou uid différent de
 * 0), ou `USER root` seulement si l'ENTRYPOINT est /usr/local/bin/entrypoint.sh, que ce stage y copie deploy/entrypoint.sh,
 * et que celui-ci descend sur un uid non root avant toute autre chose (F-20261001-R01 et décision D-32 : sous
 * no-new-privileges, Render, le worker ne peut recevoir ses capacités de changement d'uid que d'un démarrage en root). Le
 * test d'image (tests/image, assert_sandbox_image_privileges) vérifie la même chose sur le conteneur.
 */
export function checkImageNonRoot(label: string, dockerfile: string, entrypoint?: string): string[] {
  const stages = dockerfile.split(/^\s*FROM\s/m).slice(1);
  const last = stages[stages.length - 1] ?? '';
  const users = [...last.matchAll(/^\s*USER\s+(\S+)/gm)].map((m) => m[1] ?? '');
  const user = users[users.length - 1];
  if (user !== undefined && !/^(root|0)(:|$)/.test(user)) return [];
  const root = `${label} : l'image finale tourne en root`;
  if (!/^\s*ENTRYPOINT \["\/usr\/local\/bin\/entrypoint\.sh"(,|\])/m.test(last)) return [`${root} (USER non-root, ou ENTRYPOINT deploy/entrypoint.sh qui descend aussitôt, attendu)`];
  if (!/^\s*COPY\s+deploy\/entrypoint\.sh\s+\/usr\/local\/bin\/entrypoint\.sh\s*$/m.test(last)) return [`${root} : le dernier stage ne copie pas deploy/entrypoint.sh vers /usr/local/bin/entrypoint.sh (point d'entrée vérifié ≠ point d'entrée exécuté)`];
  if (entrypoint === undefined) return [`${root} : point d'entrée non fourni, descente de privilèges invérifiable`];
  const problem = rootDropProblem(entrypoint);
  return problem === undefined ? [] : [`${root} : deploy/entrypoint.sh, ${problem}`];
}

/**
 * Images des modules (ADR 23 ; `modules/<nom>/Dockerfile`, SYM Browser d'abord) : même porte que l'image de SYM, sans
 * l'exception du point d'entrée root (aucun module ne descend d'uid au démarrage).
 */
export function checkModuleImages(root: string): string[] {
  const modules = join(root, 'modules');
  if (!existsSync(modules)) return [];
  return readdirSync(modules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(modules, entry.name, 'Dockerfile')))
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => checkImageNonRoot(`modules/${name}/Dockerfile`, readFileSync(join(modules, name, 'Dockerfile'), 'utf8')));
}

/** Garde réelle : tous les workflows, le workflow de release s'il existe, le Dockerfile de SYM et ceux des modules. */
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
    if (name === 'ci.yml') problems.push(...checkCiImageJob(`.github/workflows/${name}`, yaml));
  }
  if (!existsSync(join(dir, 'ci.yml'))) problems.push('.github/workflows/ci.yml : workflow de CI absent');
  problems.push(...checkReleasePleaseConfigs(repo));
  problems.push(...checkImageNonRoot('deploy/Dockerfile', readFileSync(join(root, 'deploy/Dockerfile'), 'utf8'), readFileSync(join(root, 'deploy/entrypoint.sh'), 'utf8')));
  problems.push(...checkModuleImages(root));
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
