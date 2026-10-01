// SPDX-License-Identifier: AGPL-3.0-only
// Registre des allégations (22 §3.2, u7 05, u8 07) : source unique `.github/claims.json`, `.github/CLAIMS.md` en est généré.
// Une allégation sans preuve, un chiffre sans mesure, une entrée « à relire » ou « bloqué » affichée sur une surface font
// échouer le job `vitrine`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { githubDir, repoRoot, runtimeDir } from './paths.ts';

const STATUSES = ['relu', 'à relire', 'bloqué'] as const;
type ClaimStatus = (typeof STATUSES)[number];
const SURFACES = ['readme', 'landing', 'responsible-use'] as const;

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

export type ClaimsFile = { version: number; note?: string; claims: Claim[] };

export function loadClaims(path = join(githubDir, 'claims.json')): ClaimsFile {
  return JSON.parse(readFileSync(path, 'utf8')) as ClaimsFile;
}

/** Texte d'une puce de README rendu en texte simple (gras retiré), pour la comparer à l'entrée du registre. */
export const plainBullet = (line: string): string => line.replace(/^-\s+/, '').replace(/\*\*/g, '').trim();

export type ProofContext = {
  /** Texte de tous les fichiers de test du dépôt (noms `assert_…`). */
  testCorpus: string;
  /** Invariants connus (`tests/invariants.json`). */
  invariants: ReadonlySet<string>;
  /** Un chemin relatif existe-t-il (racine du dépôt) ? */
  exists: (path: string) => boolean;
  /** Date de la dernière release (AAAA-MM-JJ), ou undefined avant la première. */
  lastReleaseDate?: string | undefined;
  today: string;
};

/** Problèmes du registre (liste vide : conforme). */
export function claimProblems(file: ClaimsFile, context: ProofContext): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const claim of file.claims) {
    const at = `claims.json « ${claim.id} »`;
    if (!/^[a-z0-9-]+$/.test(claim.id)) problems.push(`${at} : identifiant invalide`);
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
    if (claim.proof.length === 0) problems.push(`${at} : aucune preuve (une allégation sans preuve est interdite)`);
    for (const proof of claim.proof) {
      if (/^INV\d+$/.test(proof)) {
        if (!context.invariants.has(proof)) problems.push(`${at} : invariant ${proof} absent de tests/invariants.json`);
      } else if (/^assert_[a-z0-9_]+$/.test(proof)) {
        if (!context.testCorpus.includes(proof)) problems.push(`${at} : test ${proof} introuvable`);
      } else if (!context.exists(proof)) problems.push(`${at} : preuve ${proof} introuvable`);
    }
    if (claim.status === 'bloqué' && !claim.note) problems.push(`${at} : une entrée bloquée dit pourquoi (note)`);
  }
  return problems;
}

/** Entrées non relues parmi celles dont un texte (en ou fr) figure dans `surfaceText` : à afficher nulle part. */
export function unreviewedDisplayed(file: ClaimsFile, surfaceText: string): string[] {
  return file.claims
    .filter((claim) => claim.status !== 'relu' && (surfaceText.includes(claim.en) || surfaceText.includes(claim.fr)))
    .map((claim) => `« ${claim.id} » (${claim.status}) est affichée sur une surface`);
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

/** Contexte de preuve du dépôt réel. */
export function repoProofContext(readTestCorpus: () => string): ProofContext {
  const table = JSON.parse(readFileSync(join(runtimeDir, 'tests/invariants.json'), 'utf8')) as { invariant: string }[];
  const invariants = new Set(table.flatMap((row) => row.invariant.split(',').map((part) => part.trim()).filter((part) => /^INV\d+$/.test(part))));
  return {
    testCorpus: readTestCorpus(),
    invariants,
    exists: (path) => existsSync(join(repoRoot, path)) || existsSync(join(runtimeDir, path)),
    lastReleaseDate: lastReleaseDate(),
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
    'Every factual sentence of the public surfaces (README, landing, responsible-use page) comes from this register, with its proof',
    'and the date it was last reviewed. A claim marked `à relire` or `bloqué` is shown nowhere. Source: `claims.json`.',
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
