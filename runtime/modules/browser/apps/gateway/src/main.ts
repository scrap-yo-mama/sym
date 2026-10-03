// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée de l'image (CMD) : lit `SYMB_MODE` (défaut `all`) et démarre le rôle demandé (cdc/sym-browser 03 § 4).
// Configuration invalide : sortie code 1 et message qui nomme chaque variable. `--check-config` valide sans écouter.
// Tâche 5.1 : chaque rôle est assemblé (base, migrations, battement, Chromium) et `/readyz` reflète son état réel.
import { runService } from '@sym-browser/core';
import { prepareRuntime } from './runtime/index.js';

await runService({ argv: process.argv.slice(2), prepare: (config, log) => prepareRuntime(config, { log }) });
