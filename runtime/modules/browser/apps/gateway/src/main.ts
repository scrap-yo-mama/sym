// SPDX-License-Identifier: AGPL-3.0-only
// Point d'entrée de l'image (CMD) : lit `SYMB_MODE` (défaut `all`) et démarre le rôle demandé (cdc/sym-browser 03 § 4, tâche 0.4).
// Configuration invalide : sortie code 1 et message qui nomme chaque variable. `--check-config` valide sans écouter.
import { runService } from '@sym-browser/core';

await runService({ argv: process.argv.slice(2) });
