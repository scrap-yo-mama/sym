// SPDX-License-Identifier: AGPL-3.0-only
// Noyau de SYM Browser (cdc/sym-browser 03 § 9) : chiffrement (tâche 0.3), configuration et modes (0.4), journaux masqués.
export * from './crypto/index.js';
// Noyau de SYM Browser (cdc/sym-browser 03 § 9) : chiffrement, clé maîtresse, rekey et masquage des journaux (tâche 0.3),
// configuration et modes (0.4).
// configuration et modes (0.4), authentification : clés d'API, scopes, jetons de connexion, premier démarrage (2.1).
export * from './auth/index.js';
// Noyau de SYM Browser (cdc/sym-browser 03 § 9) : chiffrement (tâche 0.3), configuration et modes (0.4), journaux masqués,
// constantes de capacité mesurées (0.6).
// configuration et modes (0.4), stockage des objets (3.0), profils persistants (3.1).
export * from './profiles/index.js';
export * from './storage/index.js';
// Tâche 0.4 : catalogue d'environnement, chargement validé, hôte de service (`/healthz`, `/readyz`, drainage).
export * from './crypto/index.js';
// configuration, modes et hôte de service (0.4), stockage des objets (3.0).
export * from './storage/index.js';
export * from './net/index.js';
export {
  BROWSER_ENV_CATALOG,
  BROWSER_ENV_GROUPS,
  SERVICE_MODES,
  browserEnvNames,
  findEnvVariable,
  isServiceMode,
  unknownReservedVariables,
  unknownReservedVariablesWarning,
  type BrowserEnvGroup,
  type BrowserEnvVariable,
  type ServiceMode,
  type ServiceRole,
} from './config/env-catalog.js';
export { LOG_LEVELS, NODE_ENVS, describeConfig, loadConfig, type BrowserConfig, type LoadOptions, type LogLevel, type NodeEnv, type ObjectStoreConfig } from './config/load.js';
export { ConfigError, Reader, type Env } from './config/reader.js';
export { Secret } from './config/secret.js';
export { createLogger, runService, startService, type Logger, type ReadinessCheck, type RunOptions, type ServiceHandle, type ServiceOptions } from './service/service.js';
export * from './capacity.js';
export { createLogger, runService, SHUTDOWN_TEARDOWN_MS, startService, type Logger, type ReadinessCheck, type RunOptions, type ServiceHandle, type ServiceOptions } from './service/service.js';
export * from './session/index.js';
export { sendableCloseCode } from './relay/close-code.js';
