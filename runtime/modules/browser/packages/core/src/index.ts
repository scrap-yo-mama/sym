// SPDX-License-Identifier: AGPL-3.0-only
// Noyau de SYM Browser (cdc/sym-browser 03 § 9) : chiffrement (tâche 0.3), configuration et modes (0.4), journaux masqués,
// constantes de capacité mesurées (0.6).
// Tâche 0.4 : catalogue d'environnement, chargement validé, hôte de service (`/healthz`, `/readyz`, drainage).
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
export * from './capacity.js';
