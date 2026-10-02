// SPDX-License-Identifier: MIT
// SDK TypeScript de SYM Browser (MIT ; cdc/sym-browser 04 § 10). Les types viennent du contrat `@sym/contracts/browser`.
// Squelette de la tâche 0.1 : types et versions seulement ; le client `SymBrowser` arrive avec la tâche 3.4.
import { BROWSER_API_VERSION, BROWSER_ENGINE, BROWSER_PROTOCOL_VERSION } from '@sym/contracts/browser';

export type {
  CreateSessionRequest,
  EgressPolicy,
  EgressState,
  Session,
  SessionEvent,
  SessionState,
  SessionType,
  VersionInfo,
} from '@sym/contracts/browser';

/** Versions que ce SDK sait parler : API REST, contrat, et Playwright attendu côté client. */
export const SDK_COMPATIBILITY = {
  api: BROWSER_API_VERSION,
  protocol: BROWSER_PROTOCOL_VERSION,
  playwright: BROWSER_ENGINE.playwright,
} as const;
