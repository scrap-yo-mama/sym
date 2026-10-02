// SPDX-License-Identifier: AGPL-3.0-only
// Noyau de SYM Browser (cdc/sym-browser 03 § 9) : chiffrement, clé maîtresse, rekey et masquage des journaux (tâche 0.3),
// configuration, modes et hôte de service (0.4), stockage des objets (3.0).
export * from './crypto/index.js';
export * from './storage/index.js';
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
export * from './session/index.js';
export { sendableCloseCode } from './relay/close-code.js';
