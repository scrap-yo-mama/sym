// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm eval [--level N0|N1|N2|N3]` : banc d'évaluation de l'agent (tâche 2.8, 15 §11). N0 (défaut) : faux fournisseur,
// fixtures, base jetable, chaque PR. N1 et N2 : fournisseur BYO (EVAL_LLM_CONFIG, hors du dépôt), promptfoo en image Docker
// sur réseau interne. N3 : benchmark sur sites réels, manuel et sous GO, hors CI : non automatisé ici. Rapport dans
// eval/results/<niveau>/ (report.md, report.json, records.jsonl) ; code de sortie non nul si une règle de blocage NOUVELLE
// se déclenche (défauts connus datés : eval/known-defects.json).
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const at = args.indexOf('--level');
const level = at === -1 ? 'N0' : (args[at + 1] ?? '');
if (!['N0', 'N1', 'N2', 'N3'].includes(level)) {
  console.error('usage : pnpm eval [--level N0|N1|N2|N3]');
  process.exit(2);
}
if (level === 'N3') {
  console.error('N3 : benchmark de 20 API sur sites réels (15 §11), manuel, sous GO et hors CI ; liste nominative non constituée. Non automatisé.');
  process.exit(2);
}
const file = level === 'N0' ? 'eval/bench/src/n0.eval.test.ts' : 'eval/bench/src/nreal.eval.test.ts';
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--project', 'eval', file], { stdio: 'inherit', env: { ...process.env, EVAL_LEVEL: level } });
console.log(`rapport : eval/results/${level.toLowerCase()}/report.md`);
process.exit(result.status ?? 1);
