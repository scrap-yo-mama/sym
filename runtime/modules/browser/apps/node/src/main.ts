// SPDX-License-Identifier: AGPL-3.0-only
// Binaire du nœud : même hôte de service que la passerelle, mais `SYMB_MODE` vaut `node` quand il est absent (tâche 0.4).
import { runService } from '@sym-browser/core';

await runService({ argv: process.argv.slice(2), defaultMode: 'node' });
