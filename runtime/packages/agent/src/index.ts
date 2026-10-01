// Moteur agentique serveur (tâche 0.6a) : boucle maison derrière `AgentEngine`, canal `agent_step` Playwright, verrou de domaines.
export const PACKAGE_NAME = '@runtime/agent';

export { HomeLoopEngine, HOME_LOOP_SYSTEM_PROMPT, homeLoopPromptVersion, frameSnapshot, type HomeLoopOptions, type HomeLoopObserver } from './home-loop.js';
export { PlaywrightStepChannel, installDomainGuard, type BlockedRequest, type DomainGuard, type DomainGuardOptions, type PlaywrightChannelOptions } from './playwright-channel.js';
export { contentDigest, hasRef, hostAllowed, hostOf, semanticOf, truncateTree, DEFAULT_MAX_TREE_CHARS } from './snapshot.js';
