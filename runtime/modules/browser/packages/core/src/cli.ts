// SPDX-License-Identifier: AGPL-3.0-only
// Commandes d'exploitation du noyau (pures : sortie et code rendus, l'impression est dans bin.ts). `keygen` affiche une
// MASTER_KEY neuve sur la sortie standard, sans l'écrire ni la journaliser ; `apikey` une clé d'API neuve (`symb_…`, tâche 2.1)
// pour `SYMB_BOOTSTRAP_API_KEY` (et `BROWSER_API_KEY` côté SYM), même règle.
import { generateApiKey } from './auth/api-key.js';
import { generateMasterKey } from './crypto/master-key.js';

export type CliResult = { code: number; out: string };

const USAGE = [
  'Usage : node dist/bin.js <commande>   (depuis runtime/ : pnpm --filter @sym-browser/core keygen)',
  '  keygen   affiche une MASTER_KEY neuve (32 octets base64), sans l’écrire',
  '  apikey   affiche une clé d’API neuve (symb_…) pour SYMB_BOOTSTRAP_API_KEY, sans l’écrire',
].join('\n');

export function runCli(argv: readonly string[]): CliResult {
  const [cmd] = argv;
  if (cmd === 'keygen') return { code: 0, out: generateMasterKey() };
  if (cmd === 'apikey') return { code: 0, out: generateApiKey().key.reveal() };
  if (cmd === '--help' || cmd === '-h') return { code: 0, out: USAGE };
  return { code: 1, out: USAGE };
}
