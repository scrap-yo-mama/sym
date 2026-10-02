// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée de la CLI du noyau : `node dist/bin.js keygen` (ou `pnpm --filter @sym-browser/core keygen`).
import { runCli } from './cli.js';

const result = runCli(process.argv.slice(2));
(result.code === 0 ? process.stdout : process.stderr).write(`${result.out}\n`);
process.exitCode = result.code;
