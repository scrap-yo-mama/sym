// SPDX-License-Identifier: AGPL-3.0-only
// Nœud de SYM Browser (cdc/sym-browser 03 § 2) : pool de Chromium chauds, sessions, egress par session. Squelette de la
// tâche 0.1 : seule l'identité du moteur est posée. `browserType.connect` exige la même version majeure.mineure de
// Playwright des deux côtés (03 § 1) : la version installée doit être celle du contrat.
import { createRequire } from 'node:module';
import type { ServiceMode } from '@sym-browser/core';
import { BROWSER_ENGINE } from '@sym/contracts/browser';

export const ROLE = 'node' satisfies ServiceMode;

const require = createRequire(import.meta.url);

/** Version de `playwright-core` réellement installée. */
export function installedPlaywrightVersion(): string {
  return (require('playwright-core/package.json') as { version: string }).version;
}

export function describeRole(): string {
  return `SYM Browser ${ROLE} : Playwright ${installedPlaywrightVersion()}, Chromium ${BROWSER_ENGINE.chromium} attendu (squelette, tâche 0.1)`;
}
