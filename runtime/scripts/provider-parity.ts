// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm test:parity` (tâche 4.4 ; cdc/sym-browser 04g §5) : suite de parité à trois fournisseurs (`local`, `sym-browser`, `cdp`),
// en local, sans CI GitHub. Joue tests/browser-parity/provider-parity.parity.test.ts (vrais Chromium, Docker pour le PostgreSQL de
// l'instance SYM Browser), écrit le tableau `test | local | sym-browser | cdp` et sort en code ≠ 0 au moindre écart avec 04g §5.
// À jouer sous un verrou de test : for s in 1 2 3; do mkdir /tmp/claude-501/scrapyomama-test.lock.$s 2>/dev/null && L=… && break; done
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareParity, renderParityTable, type ParityResults } from '../tests/browser-parity/parity-table.ts';

const dir = mkdtempSync(join(tmpdir(), 'zz_parity_'));
const out = join(dir, 'parity.json');
const run = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.parity.config.ts'], { stdio: 'inherit', env: { ...process.env, PARITY_RESULTS: out } });
let code = run.status ?? 1;
try {
  const { results, capabilities } = JSON.parse(readFileSync(out, 'utf8')) as { results: ParityResults; capabilities: Parameters<typeof compareParity>[1] };
  console.log(`\nParité à trois fournisseurs (04g §5) :\n\n${renderParityTable(results)}\n`);
  const gaps = compareParity(results, capabilities);
  if (gaps.length > 0) {
    console.error(`Écarts :\n${gaps.map((g) => `  - ${g}`).join('\n')}`);
    code = code === 0 ? 1 : code;
  } else console.log('Parité conforme à 04g §5.');
} catch {
  console.error('Aucun tableau écrit : la suite a échoué avant la fin.');
  code = code === 0 ? 1 : code;
}
rmSync(dir, { recursive: true, force: true });
process.exit(code);
