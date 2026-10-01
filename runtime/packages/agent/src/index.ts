// SPDX-License-Identifier: AGPL-3.0-only
// Moteur agentique serveur (tâche 0.6a) : boucle maison derrière `AgentEngine`, canal `agent_step` Playwright, verrou de domaines.
// Tâche 0.6b : client `agent_step` du tunnel (`TunnelStepChannel`) et refus des moteurs tiers en tunnel.
// Tâche 2.4 : Stagehand 3.7.3 en production (ADR 0001), enregistreur de cibles sémantiques, E4 (rôle `extract`) et
// interpréteur E5 (`hybrid`).
// Tâche 2.1 : rôle `investigate` (schéma de sortie et chemins des champs, à partir des seuls squelettes des gisements).
export const PACKAGE_NAME = '@runtime/agent';

export { HomeLoopEngine, HOME_LOOP_SYSTEM_PROMPT, homeLoopPromptVersion, frameSnapshot, type HomeLoopOptions, type HomeLoopObserver } from './home-loop.js';
export { AGENT_CONTEXT_OPTIONS, PlaywrightStepChannel, installDomainGuard, newAgentContext, type BlockedRequest, type DomainGuard, type DomainGuardOptions, type PlaywrightChannelOptions } from './playwright-channel.js';
export { contentDigest, hasRef, hostAllowed, hostOf, semanticOf, truncateTree, DEFAULT_MAX_TREE_CHARS } from './snapshot.js';
export { AgentStepProtocolError, AgentStepRefusedError, ThirdPartyEngineNotViaTunnelError, TunnelStepChannel, assertTunnelEngine, runAgentInTunnel, type AgentStepTransport, type AgentTunnelRunOptions } from './tunnel-channel.js';
export { STAGEHAND_VERSION, StagehandEngine, jsonSchemaToZod, stagehandTrace, type StagehandEngineHooks, type StagehandEngineOptions, type StagehandLlmCall } from './stagehand-engine.js';
export { cleanUrlTokens, sanitizeModelPrompt, type PromptSanitizeOptions } from './stagehand-prompt.js';
export {
  AgentToolsetNotClosedError,
  STAGEHAND_EXCLUDED_TOOLS,
  STAGEHAND_TOOL_ACTIONS,
  StagehandNotLocalError,
  assertStagehandLocalOnly,
  forbiddenEnvPresent,
  toolsOutsideClosedList,
} from './stagehand-guards.js';
export { installSemanticRecorder, type SemanticClick, type SemanticRecorder } from './semantic-recorder.js';
export { EXTRACT_SYSTEM_PROMPT, extractMessages, extractPromptVersion, extractRecordsWithLlm, recordsSchema, sourceLabel, type LlmExtraction } from './agent-extract.js';
export { extractLabelsFromPage, readPageView, runHybridSteps, type HybridFailure, type HybridHooks } from './hybrid-runner.js';
export { INVESTIGATE_SYSTEM_PROMPT, investigateMessages, investigatePromptVersion, proposeInvestigation, type InvestigateArgs, type InvestigateResult } from './investigate.js';
