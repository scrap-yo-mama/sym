// SPDX-License-Identifier: AGPL-3.0-only
// Commits conventionnels (16 §3) : release-please calcule la version et les notes depuis ces sujets. Vérifié en CI sur
// le titre de la PR (la fusion par squash en fait le sujet du commit) ; le titre arrive par l'environnement, jamais par
// une interpolation dans le script.
const TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'revert', 'style'] as const;

const SUBJECT = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9._/-]*\\))?(!)?: \\S.{0,99}$`);

/** Problème d'un sujet de commit, ou undefined s'il est conforme (`type(portée)!: description`, 100 caractères au plus). */
export function checkSubject(subject: string): string | undefined {
  if (/^Merge /.test(subject)) return undefined;
  if (SUBJECT.test(subject)) return undefined;
  return `sujet « ${subject} » non conforme : attendu \`type(portée)!: description\` avec type parmi ${TYPES.join(', ')} (description de 100 caractères au plus)`;
}

/** Un changement cassant (`!` ou pied `BREAKING CHANGE:`) doit être déclaré comme tel pour monter la MINOR avant la 1.0. */
export function isBreaking(subject: string, body = ''): boolean {
  return /^[a-z]+(\([^)]*\))?!:/.test(subject) || /^BREAKING[ -]CHANGE: \S/m.test(body);
}

if (import.meta.main) {
  const title = process.env['PR_TITLE'] ?? process.argv[2];
  if (title === undefined) {
    console.error('usage : PR_TITLE="feat: ..." node scripts/release/conventional.ts');
    process.exit(2);
  }
  const problem = checkSubject(title);
  if (problem !== undefined) {
    console.error(problem);
    process.exit(1);
  }
  console.log('commit conventionnel : conforme.');
}
