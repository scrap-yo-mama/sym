// SPDX-License-Identifier: AGPL-3.0-only
// Bac à sable du code généré (INV7, tâche 1.5). Voir README.md.
export { ProcessSandboxEngine, DEFAULT_SANDBOX_LIMITS, type ProcessSandboxOptions } from './engine.js';
export {
  createSandboxBridges,
  SandboxBridgeError,
  type BridgeFetch,
  type BridgeResponse,
  type SandboxBridgeHandle,
  type SandboxBridgeOptions,
} from './bridges.js';
export { assertSandboxSupported, checkIsolatedVmVersion } from './version.js';
