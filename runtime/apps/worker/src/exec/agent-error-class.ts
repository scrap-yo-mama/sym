// SPDX-License-Identifier: AGPL-3.0-only
// Classe d'erreur du moteur agentique (U1.12, UX-23). Un essai `agent` ou `agent_fetch` qui lève une exception sortait en
// `trial_error` sans cause. La classe est un CODE FERMÉ lu sur le TYPE de l'erreur (lancement de Chromium, délai, navigateur
// fermé, navigation, modèle) ; le message n'est jamais recopié (il peut porter une URL, une valeur du site ou personnelle).
import { LlmError } from '@runtime/llm';
import { ChromiumLaunchError } from '../browser/agent-browser.js';

export function agentEngineErrorClass(error: unknown): string {
  if (error instanceof ChromiumLaunchError) return error.message.split(':', 1)[0]!;
  if (error instanceof LlmError) return `llm_${error.class}`;
  if (!(error instanceof Error)) return 'unknown';
  if (error.name === 'TimeoutError' || /timeout|timed out/i.test(error.message)) return 'timeout';
  if (/has been closed|target closed|browser.*(closed|disconnected)/i.test(error.message)) return 'browser_closed';
  if (/net::ERR_|ERR_NAME_NOT_RESOLVED|ECONNREFUSED|ENOTFOUND|navigat/i.test(error.message)) return 'navigation_failed';
  return 'unknown';
}
