// SPDX-License-Identifier: AGPL-3.0-only
// Garde X6 (assert_x6_guard) : aucun Python ni notebook, nulle part dans le dépôt.
// Vérifie depuis la racine git (et non depuis runtime/) : `git ls-files '*.py' '*.ipynb'` = 0,
// et aucun fichier indexé n'a un nom suspect (legs historique, cdc/scrapyomama-runtime/_exclusions.md X6).
// `--history` (assert_x6_history_clean, tâche 4.9) : audite TOUT l'historique git avant une release publique (X6, 08b §5) :
// chaque chemin ajouté ou modifié par un commit de n'importe quelle référence, fusions comprises. Un clone superficiel
// (actions/checkout sans `fetch-depth: 0`) ne contient pas l'historique : l'audit le refuse au lieu de passer à vide.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const SUSPICIOUS_BASENAMES: RegExp[] = [
  /^anticaptcha/,
  /captcha_solver/,
  /^scraper\.py$/,
  /^google_scraper\.py$/,
];

/** Renvoie les fichiers qui violent la garde, parmi une liste de chemins indexés. */
export function findX6Violations(files: readonly string[]): string[] {
  return files.filter((file) => {
    const name = basename(file).toLowerCase();
    return (
      name.endsWith('.py') ||
      name.endsWith('.ipynb') ||
      SUSPICIOUS_BASENAMES.some((pattern) => pattern.test(name))
    );
  });
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Garde réelle : racine git, `git ls-files '*.py' '*.ipynb'` puis noms suspects sur tout l'index. */
export function checkRepo(cwd: string = process.cwd()): string[] {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const byExtension = git(root, ['ls-files', '*.py', '*.ipynb']).split('\n').filter(Boolean);
  const all = git(root, ['ls-files']).split('\n').filter(Boolean);
  return [...new Set([...byExtension, ...findX6Violations(all)])];
}

/** Historique entier : chemins interdits avec le commit qui les a introduits ; refus d'un clone superficiel. */
export function checkHistory(cwd: string = process.cwd()): string[] {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const common = git(root, ['rev-parse', '--git-common-dir']).trim();
  if (existsSync(resolve(root, common, 'shallow'))) {
    return ['historique git superficiel (clone --depth) : audit X6 impossible, extraire tout l\'historique (fetch-depth: 0)'];
  }
  // -m : diff de chaque fusion contre chacun de ses parents ; --no-renames : un renommage montre aussi l'ancien chemin.
  // core.quotePath=false : un chemin non ASCII n'est pas entre guillemets (`"café.py"` masquerait l'extension) ; les rares
  // chemins encore cités (guillemet, tabulation, saut de ligne) sont dépouillés de leurs guillemets extérieurs.
  const log = git(root, ['-c', 'core.quotePath=false', 'log', '--all', '-m', '--no-renames', '--name-only', '--format=commit %H']);
  const introducedIn = new Map<string, string>();
  let commit = '';
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) commit = line.slice(7, 19);
    else if (line !== '') introducedIn.set(line.replace(/^"(.*)"$/, '$1'), commit); // git log va du plus récent au plus ancien : le dernier vu est le plus ancien
  }
  return findX6Violations([...introducedIn.keys()]).sort().map((path) => `${path} (commit ${introducedIn.get(path) ?? '?'})`);
}

if (import.meta.main && process.argv.includes('--history')) {
  const violations = checkHistory();
  if (violations.length > 0) {
    console.error(`Garde X6 : historique git à purger avant toute release publique :\n${violations.map((v) => `  - ${v}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Garde X6 : historique git complet audité, aucun .py, .ipynb ni nom suspect.');
} else if (import.meta.main) {
  const violations = checkRepo();
  if (violations.length > 0) {
    console.error(`Garde X6 : fichiers interdits dans l'index :\n${violations.map((v) => `  - ${v}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Garde X6 : aucun .py, .ipynb ni nom suspect dans le dépôt.');
}
