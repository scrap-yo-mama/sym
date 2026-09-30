// Garde X6 (assert_x6_guard) : aucun Python ni notebook, nulle part dans le dépôt.
// Vérifie depuis la racine git (et non depuis runtime/) : `git ls-files '*.py' '*.ipynb'` = 0,
// et aucun fichier indexé n'a un nom suspect (legs historique, cdc/scrapyomama-runtime/_exclusions.md X6).
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

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

if (import.meta.main) {
  const violations = checkRepo();
  if (violations.length > 0) {
    console.error(`Garde X6 : fichiers interdits dans l'index :\n${violations.map((v) => `  - ${v}`).join('\n')}`);
    process.exit(1);
  }
  console.log('Garde X6 : aucun .py, .ipynb ni nom suspect dans le dépôt.');
}
