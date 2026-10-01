// SPDX-License-Identifier: AGPL-3.0-only
// Moteur agentique serveur (tâche 0.6a) : boucle maison derrière `AgentEngine`, canal `agent_step` Playwright, verrou de domaines.
// Tâche 0.6b : client `agent_step` du tunnel (`TunnelStepChannel`) et refus des moteurs tiers en tunnel.
export const PACKAGE_NAME = '@runtime/agent';

export { HomeLoopEngine, HOME_LOOP_SYSTEM_PROMPT, homeLoopPromptVersion, frameSnapshot, type HomeLoopOptions, type HomeLoopObserver } from './home-loop.js';
export { AGENT_CONTEXT_OPTIONS, PlaywrightStepChannel, installDomainGuard, newAgentContext, type BlockedRequest, type DomainGuard, type DomainGuardOptions, type PlaywrightChannelOptions } from './playwright-channel.js';
export { contentDigest, hasRef, hostAllowed, hostOf, semanticOf, truncateTree, DEFAULT_MAX_TREE_CHARS } from './snapshot.js';
export { AgentStepProtocolError, AgentStepRefusedError, ThirdPartyEngineNotViaTunnelError, TunnelStepChannel, assertTunnelEngine, runAgentInTunnel, type AgentStepTransport, type AgentTunnelRunOptions } from './tunnel-channel.js';
