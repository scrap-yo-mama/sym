// SPDX-License-Identifier: AGPL-3.0-only
// Passerelle de SYM Browser (cdc/sym-browser 03 § 2) : REST `/v1`, relais WSS `/playwright` et `/cdp`, SSE. Squelette de la
// tâche 0.1 ; la configuration, `/healthz` et `/readyz` sont dans `@sym-browser/core` depuis la tâche 0.4 (aucune route REST encore).
import type { ServiceMode } from '@sym-browser/core';
import { BROWSER_API_VERSION, BROWSER_ENGINE } from '@sym/contracts/browser';

export const ROLE = 'gateway' satisfies ServiceMode;

export function describeRole(): string {
  return `SYM Browser ${ROLE} : API /v${BROWSER_API_VERSION}, Playwright ${BROWSER_ENGINE.playwright} (squelette, tâche 0.1)`;
}
