// SPDX-License-Identifier: AGPL-3.0-only
// Commandes d'exploitation du noyau (pures : sortie et code rendus, l'impression est dans bin.ts). `keygen` affiche une
// MASTER_KEY neuve sur la sortie standard, sans l'écrire ni la journaliser.
import { generateMasterKey } from './crypto/master-key.js';

export type CliResult = { code: number; out: string };

const USAGE = [
  'Usage : node dist/bin.js <commande>   (depuis runtime/ : pnpm --filter @sym-browser/core keygen)',
  '  keygen   affiche une MASTER_KEY neuve (32 octets base64), sans l’écrire',
].join('\n');

export function runCli(argv: readonly string[]): CliResult {
  const [cmd] = argv;
  if (cmd === 'keygen') return { code: 0, out: generateMasterKey() };
  if (cmd === '--help' || cmd === '-h') return { code: 0, out: USAGE };
  return { code: 1, out: USAGE };
}
