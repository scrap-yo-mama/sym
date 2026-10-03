// SPDX-License-Identifier: AGPL-3.0-only
// Registre des allégations (22 §3.2, u7 05, u8 07) : source unique `.github/claims.json`, `.github/CLAIMS.md` en est généré.
// Une allégation sans preuve, un chiffre sans mesure, une entrée « à relire » ou « bloqué » affichée sur une surface font
// échouer le job `vitrine`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { githubDir, repoRoot, runtimeDir } from './paths.ts';
import { normalize } from './text.ts';

const STATUSES = ['relu', 'à relire', 'bloqué'] as const;
type ClaimStatus = (typeof STATUSES)[number];
const SURFACES = ['readme', 'landing', 'landing-compare', 'responsible-use', 'repo', 'reserve'] as const;
export type Surface = (typeof SURFACES)[number];

type Claim = {
  id: string;
  surfaces: string[];
  en: string;
  fr: string;
  /** Invariant (`INV9`), test nommé (`assert_…`) ou chemin d'un fichier du dépôt. */
  proof: string[];
  /** Date de relecture (AAAA-MM-JJ). */
  reviewed: string;
  status: ClaimStatus;
  /** Tâche liée : l'entrée repasse « à relire » à chaque livraison de cette tâche. */
  task?: string;
  note?: string;
};

/** Pages du site de doc générées à la construction (apps/docs/scripts/gen-reference.ts), non versionnées : leurs sources (chemins de runtime/). */
const GENERATED_PAGE_SOURCES: Readonly<Record<string, readonly string[]>> = {
  'reference/rest': ['packages/client/openapi/openapi.yaml', 'apps/docs/scripts/gen-reference.ts'],
};

export type ClaimsFile = { version: number; note?: string; claims: Claim[] };

export function loadClaims(path = join(githubDir, 'claims.json')): ClaimsFile {
  return JSON.parse(readFileSync(path, 'utf8')) as ClaimsFile;
}

/** Texte d'une puce de README rendu en texte simple (gras retiré), pour la comparer à l'entrée du registre. */
export const plainBullet = (line: string): string => line.replace(/^-\s+/, '').replace(/\*\*/g, '').trim();

export type ProofContext = {
  /** Titres des tests réels du dépôt (noms `assert_…`), hors test.todo et hors tests de la vitrine (corpus.ts). */
  testCorpus: string;
  /** Invariants connus (`tests/invariants.json`). */
  invariants: ReadonlySet<string>;
  /** Un chemin relatif existe-t-il (racine du dépôt) ? */
  exists: (path: string) => boolean;
  /** Date de la dernière release (AAAA-MM-JJ), ou undefined avant la première. */
  lastReleaseDate?: string | undefined;
  /** Date (AAAA-MM-JJ) de la dernière livraison d'une tâche (dernier commit « <tâche> — »), ou undefined si jamais livrée. */
  taskDeliveredOn?: ((task: string) => string | undefined) | undefined;
  today: string;
};

/**
 * Une entrée relue qui affirme une fonction cite une preuve de CETTE fonction (22 §3.2 : affichée seulement une fois prouvée et
 * relue) : la réparation par un test de réparation, la reprise par étape par un assert de 19 §4, le serveur MCP par un test du
 * serveur MCP. Une preuve voisine (la garde de classification pour la réparation, la réparation de la stratégie pour la reprise par
 * étape, l'OpenAPI pour MCP) ne suffit pas, et une note qui reporte la preuve à la livraison non plus.
 */
const CAPABILITY_PROOFS: readonly { name: string; claim: RegExp; proof: RegExp }[] = [
  { name: 'la réparation', claim: /\brepair|répar/i, proof: /repair/i },
  // La reprise par étape (2.13, 19 §4 : « repairs step by step », « it repairs the step that broke ») : un assert de 19 §4, jamais la
  // réparation de la stratégie (2.3), preuve voisine. Seule une affirmation est visée (« Not delivered yet: step-by-step repair » non).
  {
    name: 'la reprise par étape',
    claim: /\brepairs? (step by step|the step)\b|\brépare (étape par étape|l['’]étape)/i,
    proof: /^assert_(step_classification_guard|step_patch_bounded|side_effect_computed_by_code)$/,
  },
  { name: 'le serveur MCP', claim: /\bMCP\b/, proof: /mcp|assert_tool_definitions_budget/i },
];
const DEFERRED_PROOF = /s'ajoute à (sa|leur) livraison|added when .* deliver/i;

/**
 * Formulation prudente imposée (22 §3.2) : « tourne sans LLM **quand la stratégie le permet** ». Les stratégies E4 à E6 et une API
 * `not_compilable` rejouent avec un modèle (04 §2) : « without an LLM » / « sans LLM » est toujours suivi de la réserve. Gras ignoré.
 */
const CAUTIOUS: Record<'en' | 'fr', { claim: RegExp; caution: string }> = {
  en: { claim: /\b(without (an? )?LLMs?|no LLMs?)\b/gi, caution: ' when the strategy allows' },
  fr: { claim: /\bsans (un )?LLM\b/gi, caution: ' quand la stratégie le permet' },
};

/** Problèmes de formulation prudente d'un texte (liste vide : conforme). */
export function cautiousWordingProblems(text: string, lang: 'en' | 'fr'): string[] {
  const plain = text.replace(/\*\*/g, '');
  const { claim, caution } = CAUTIOUS[lang];
  return [...plain.matchAll(claim)]
    .filter((m) => !plain.slice((m.index ?? 0) + m[0].length).startsWith(caution))
    .map((m) => `« ${m[0]} » sans la formulation prudente imposée (22 §3.2 : « ${m[0]}${caution} »)`);
}

/** Problèmes du registre (liste vide : conforme). */
export function claimProblems(file: ClaimsFile, context: ProofContext): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const claim of file.claims) {
    const at = `claims.json « ${claim.id} »`;
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(claim.id)) problems.push(`${at} : identifiant invalide`);
    if (seen.has(claim.id)) problems.push(`${at} : identifiant en double`);
    seen.add(claim.id);
    if (!claim.en?.trim() || !claim.fr?.trim()) problems.push(`${at} : texte en ou fr manquant`);
    if (!STATUSES.includes(claim.status)) problems.push(`${at} : statut « ${String(claim.status)} » inconnu (${STATUSES.join(', ')})`);
    for (const surface of claim.surfaces) if (!(SURFACES as readonly string[]).includes(surface)) problems.push(`${at} : surface « ${surface} » inconnue`);
    if (claim.surfaces.length === 0) problems.push(`${at} : aucune surface`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(claim.reviewed)) problems.push(`${at} : date de relecture invalide`);
    else if (claim.reviewed > context.today) problems.push(`${at} : relue dans le futur (${claim.reviewed})`);
    else if (claim.status === 'relu' && context.lastReleaseDate !== undefined && claim.reviewed < context.lastReleaseDate) {
      problems.push(`${at} : relue le ${claim.reviewed}, avant la dernière release (${context.lastReleaseDate}) : à relire`);
    }
    // 22 §3.2 : une entrée liée à une tâche repasse « à relire » à chaque livraison de cette tâche.
    const delivered = claim.task !== undefined && claim.status === 'relu' ? context.taskDeliveredOn?.(claim.task) : undefined;
    if (delivered !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(claim.reviewed) && claim.reviewed < delivered) {
      problems.push(`${at} : relue le ${claim.reviewed}, avant la livraison de sa tâche (tâche ${claim.task ?? ''} livrée le ${delivered}) : à relire`);
    }
    if (claim.proof.length === 0) problems.push(`${at} : aucune preuve (une allégation sans preuve est interdite)`);
    for (const proof of claim.proof) {
      // Preuves de la landing (tâche 4.11) : `inv:`, `test:`, `file:`, `page:`, `decision:` ; leur sens exact est contrôlé par la porte du GO (check:landing-go).
      const prefixed = /^(inv|test|file|page|decision):(.+)$/.exec(proof);
      if (prefixed) {
        const [, kind = '', value = ''] = prefixed;
        if (kind === 'inv') {
          if (!context.invariants.has(value)) problems.push(`${at} : invariant ${value} absent de tests/invariants.json`);
        } else if (kind === 'test') {
          // Un test nommé de la landing peut être encore en test.todo avant le GO : la porte `check:landing-go` (tâche 4.11) l'exige alors vrai ; ici seul le nom est contrôlé.
          if (!/^assert_[a-z0-9_]+$/.test(value)) problems.push(`${at} : nom de test ${value} invalide`);
        } else if (kind === 'page') {
          // Une page générée à la construction du site de doc (ignorée par git) est prouvée par ses sources : spécification et générateur.
          const sources = GENERATED_PAGE_SOURCES[value];
          if (sources) {
            for (const source of sources) if (!context.exists(source)) problems.push(`${at} : page ${value} : source ${source} introuvable`);
          } else if (!context.exists(`apps/docs/content/${value}.md`)) problems.push(`${at} : page ${value} introuvable`);
        } else if (kind === 'decision') {
          if (!/^D-\d+$/.test(value)) problems.push(`${at} : décision ${value} invalide`);
        } else if (!context.exists(value)) problems.push(`${at} : preuve ${proof} introuvable`);
      } else if (/^INV\d+$/.test(proof)) {
        if (!context.invariants.has(proof)) problems.push(`${at} : invariant ${proof} absent de tests/invariants.json`);
      } else if (/^assert_[a-z0-9_]+$/.test(proof)) {
        if (!new RegExp(`(?<![a-z0-9_])${proof}(?![a-z0-9_])`).test(context.testCorpus)) problems.push(`${at} : test ${proof} introuvable (aucun test réel, test.todo exclu)`);
      } else if (!context.exists(proof)) problems.push(`${at} : preuve ${proof} introuvable`);
    }
    for (const lang of ['en', 'fr'] as const) for (const problem of cautiousWordingProblems(claim[lang] ?? '', lang)) problems.push(`${at} (${lang}) : ${problem}`);
    if (claim.status === 'bloqué' && !claim.note) problems.push(`${at} : une entrée bloquée dit pourquoi (note)`);
    // Les preuves propres visent les surfaces du dépôt (README, dépôt) ; celles de la landing relèvent de la porte du GO (4.11, check:landing-go).
    if (claim.status === 'relu') {
      const ownProofs = claim.surfaces.some((surface) => surface === 'readme' || surface === 'repo' || surface === 'responsible-use' || surface === 'reserve');
      for (const capability of ownProofs ? CAPABILITY_PROOFS : []) {
        if ((capability.claim.test(claim.en) || capability.claim.test(claim.fr)) && !claim.proof.some((proof) => capability.proof.test(proof))) {
          problems.push(`${at} : affirme ${capability.name} sans preuve propre (relue, elle s'affiche)`);
        }
      }
      if (claim.note && DEFERRED_PROOF.test(claim.note)) problems.push(`${at} : relue alors que sa note reporte la preuve à une livraison`);
    }
  }
  return problems;
}

/** Entrées non relues parmi celles dont un texte (en ou fr) figure dans `surfaceText` : à afficher nulle part. */
export function unreviewedDisplayed(file: ClaimsFile, surfaceText: string): string[] {
  return file.claims
    .filter((claim) => claim.status !== 'relu' && (surfaceText.includes(claim.en) || surfaceText.includes(claim.fr)))
    .map((claim) => `« ${claim.id} » (${claim.status}) est affichée sur une surface`);
}

/**
 * Les libellés très courts (« Chez toi », « With you » : cellules du tableau comparatif de la landing) ne sont pas des phrases :
 * moins de 12 caractères, ils ne sont pas comptés comme affichés (faux positifs dans n'importe quel texte).
 */
/**
 * Entrées du registre affichées sur `surface` (texte en ou fr présent) alors qu'elles ne portent pas cette surface : par
 * exemple un engagement « Usage responsable » recopié dans le README (D-46). Liste vide : conforme.
 */
export function foreignClaimsDisplayed(file: ClaimsFile, surfaceText: string, surface: Surface): string[] {
  const haystack = normalize(surfaceText);
  // Un libellé de cellule du comparatif n'est pas une phrase : il n'est une copie que s'il occupe toute une ligne ou une cellule de tableau.
  const cells = new Set(surfaceText.split('\n').flatMap((line) => line.split('|')).map((cell) => normalize(cell)));
  const shown = (claim: Claim, text: string): boolean => (claim.surfaces.every((s) => s === 'landing-compare') ? cells.has(normalize(text)) : haystack.includes(normalize(text)));
  return file.claims
    .filter((claim) => !claim.surfaces.includes(surface) && [claim.en, claim.fr].some((text) => text.trim().length >= 12 && shown(claim, text)))
    .map((claim) => `« ${claim.id} » (surfaces ${claim.surfaces.join(', ')}) est affichée sur la surface ${surface}`);
}

/**
 * Description de l'étiquette OCI de l'image (surface `repo`) : celle du dépôt une fois son entrée relue, sinon la
 * description relue de pré-version. Une image construite avant le GO ne promet rien de non livré.
 */
export function imageDescription(meta: { description: string }, file: ClaimsFile): string {
  const repo = file.claims.filter((claim) => claim.surfaces.includes('repo'));
  if (repo.find((claim) => claim.en === meta.description)?.status === 'relu') return meta.description;
  return repo.find((claim) => claim.status === 'relu' && claim.en !== meta.description)?.en ?? '';
}

/** La description du dépôt est au registre ; l'étiquette OCI porte une entrée relue, celle du dépôt dès qu'elle est relue. */
export function imageDescriptionProblems(label: string, meta: { description: string }, file: ClaimsFile): string[] {
  const problems: string[] = [];
  const repo = file.claims.filter((claim) => claim.surfaces.includes('repo'));
  const own = repo.find((claim) => claim.en === meta.description);
  if (!own) problems.push('la description du dépôt (repo-metadata.json) n\'est pas au registre (claims.json, surface repo)');
  const shown = repo.find((claim) => claim.en === label);
  if (!shown) problems.push(`la description de l'étiquette OCI n'est pas au registre (surface repo) : « ${label} »`);
  else if (shown.status !== 'relu') problems.push(`la description de l'étiquette OCI porte une entrée non relue : « ${shown.id} » (${shown.status})`);
  if (own?.status === 'relu' && label !== meta.description) problems.push('la description du dépôt est relue : l\'étiquette OCI doit la reprendre');
  return problems;
}

/** Date de la dernière release (étiquette `v*` la plus récente), ou undefined avant la première. */
function lastReleaseDate(): string | undefined {
  try {
    const out = execFileSync('git', ['tag', '--list', 'v*', '--sort=-creatordate', '--format=%(creatordate:short)'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').find((line) => /^\d{4}-\d{2}-\d{2}$/.test(line));
  } catch {
    return undefined;
  }
}

/** Motif (`git log --grep`, expression régulière de base) des commits de livraison d'une tâche : « <tâche> — … » en tête de message. */
export function taskCommitPattern(task: string): string {
  if (!/^\d+\.\d+[a-z]?$/.test(task)) throw new Error(`identifiant de tâche invalide : ${task}`);
  return `^${task.replace('.', '\\.')} —`;
}

/** Date (AAAA-MM-JJ) du dernier commit de livraison de `task` dans l'historique git, ou undefined si aucun. */
export function taskDeliveryDate(task: string): string | undefined {
  const pattern = taskCommitPattern(task);
  try {
    const out = execFileSync('git', ['log', '-1', '--date=short', '--format=%cd', `--grep=${pattern}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /^\d{4}-\d{2}-\d{2}$/.test(out.trim()) ? out.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Contexte de preuve du dépôt réel. */
export function repoProofContext(readTestCorpus: () => string): ProofContext {
  const table = JSON.parse(readFileSync(join(runtimeDir, 'tests/invariants.json'), 'utf8')) as { invariant: string }[];
  const invariants = new Set(table.flatMap((row) => row.invariant.split(',').map((part) => part.trim()).filter((part) => /^INV\d+$/.test(part))));
  return {
    testCorpus: readTestCorpus(),
    invariants,
    exists: (path) => existsSync(join(repoRoot, path)) || existsSync(join(runtimeDir, path)),
    lastReleaseDate: lastReleaseDate(),
    taskDeliveredOn: taskDeliveryDate,
    today: new Date().toLocaleDateString('sv-SE'),
  };
}

const escapeCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** `.github/CLAIMS.md` : le registre pour les lecteurs humains, généré, jamais édité à la main. */
export function claimsMarkdown(file: ClaimsFile): string {
  const lines = [
    '<!-- Generated from .github/claims.json by `pnpm vitrine:claims`. Do not edit by hand. -->',
    '# Claims register',
    '',
    'Every factual sentence of the public surfaces (README, landing, responsible-use page, repository description and image label)',
    'comes from this register, with its proof and the date it was last reviewed. A claim marked `à relire` or `bloqué` is shown',
    'nowhere. Source: `claims.json`.',
    '',
  ];
  for (const surface of SURFACES) {
    const rows = file.claims.filter((claim) => claim.surfaces.includes(surface));
    if (rows.length === 0) continue;
    lines.push(`## ${surface}`, '', '| Id | English | Français | Proof | Reviewed | Status | Task |', '|---|---|---|---|---|---|---|');
    for (const claim of rows) {
      const status = claim.note ? `${claim.status} (${claim.note})` : claim.status;
      lines.push(`| \`${claim.id}\` | ${escapeCell(claim.en)} | ${escapeCell(claim.fr)} | ${claim.proof.map((p) => `\`${p}\``).join(', ')} | ${claim.reviewed} | ${escapeCell(status)} | ${claim.task ?? ''} |`);
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
