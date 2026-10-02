// SPDX-License-Identifier: MIT
// SDK TypeScript de SYM Browser (MIT ; cdc/sym-browser 04 § 10, tâche 3.4). Client REST généré depuis l'OpenAPI du contrat
// `@sym/contracts/browser`, `connect()` et `connectCDP()` vers un `Browser` Playwright, `events()` (SSE), profils, fichiers,
// libération à la sortie du process. Dépendances de production : le contrat (MIT) et `playwright-core` (Apache-2.0).
import { BROWSER_API_VERSION, BROWSER_ENGINE, BROWSER_PROTOCOL_VERSION } from '@sym/contracts/browser';

export type {
  ConnectUrls,
  CreateSessionRequest,
  EgressPolicy,
  EgressState,
  EndReason,
  ErrorCode,
  Session,
  SessionEvent,
  SessionPage,
  SessionState,
  SessionType,
  StorageState,
  VersionInfo,
} from '@sym/contracts/browser';
export {
  LOCAL_PLAYWRIGHT_VERSION,
  SymBrowser,
  type ConnectOptions,
  type CreateOptions,
  type DownloadedFile,
  type ListFilter,
  type Profile,
  type SdkSession,
  type SessionFile,
  type SymBrowserOptions,
  type UploadedFile,
} from './client.js';
export { SymBrowserError, type SymBrowserErrorCode, type SymBrowserErrorInit } from './errors.js';
export type { EventsOptions } from './events.js';
export { OPERATIONS, type OperationId, type components, type operations, type paths } from './generated/openapi.js';

/** Versions que ce SDK sait parler : API REST, contrat, et Playwright attendu côté client. */
export const SDK_COMPATIBILITY = {
  api: BROWSER_API_VERSION,
  protocol: BROWSER_PROTOCOL_VERSION,
  playwright: BROWSER_ENGINE.playwright,
} as const;
