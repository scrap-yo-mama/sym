// SPDX-License-Identifier: AGPL-3.0-only
// Compilation E6 → E5 (04 §3.1, T4) : une trace E6 RÉUSSIE devient la liste d'étapes déterministes d'une stratégie
// `hybrid`. On compile ce que le moteur a fait (sélecteurs sémantiques rôle + nom accessible, jamais un `ref` d'instantané
// ni une classe), pas ce que la page a dit : une étape refusée par le canal (`executed: false`, domaine, écriture) n'a
// rien changé et n'est pas compilée. L'extraction est induite ensuite sur la page rejouée (label-extract.ts), puis la
// stratégie entière est rejouée sans LLM avant d'être proposée : une compilation qui ne reproduit pas la sortie échoue.
import type { AgentTraceStep } from './engine.js';
import { HYBRID_CLICK_ROLES, type HybridStep } from './specs.js';

export type CompileFailure =
  /** L'agent n'a pas terminé (`done`) : rien à compiler. */
  | 'not_done'
  /** Une saisie (`type`) : le texte n'est pas dans la trace figée par l'ADR 0001, l'étape n'est pas rejouable. */
  | 'unsupported_action'
  /** Clic sans cible sémantique (rôle interactif + nom accessible). */
  | 'missing_target'
  /** Navigation hors des domaines de l'API (jamais exécutée par le canal ; une trace qui la porte n'est pas compilée). */
  | 'navigate_off_domain'
  /** Défi détecté pendant l'E6 : aucune stratégie n'en dérive (INV6). */
  | 'challenge';

export type CompiledSteps = { readonly ok: true; readonly steps: readonly HybridStep[] } | { readonly ok: false; readonly reason: CompileFailure; readonly step?: number };

const MAX_NAME = 300;

function urlInHosts(url: string, hosts: readonly string[]): string | null {
  try {
    const u = new URL(url);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '') return null;
    return hosts.includes(u.hostname.toLowerCase()) ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * Étapes E5 d'une trace E6 réussie. Lectures (`read`) et défilements ne sont pas rejoués : l'extraction lit le texte
 * rendu, qui ne dépend pas de la position ; une page qui charge au défilement fera échouer la vérification par rejeu.
 */
export function compileAgentTrace(trace: readonly AgentTraceStep[], status: string, allowedHosts: readonly string[]): CompiledSteps {
  if (status !== 'done') return { ok: false, reason: 'not_done' };
  const steps: HybridStep[] = [];
  for (const step of trace) {
    if (step.error === 'challenge_detected') return { ok: false, reason: 'challenge', step: step.index };
    if (!step.executed) continue;
    switch (step.action) {
      case 'navigate': {
        const url = urlInHosts(step.url, allowedHosts);
        if (url === null) return { ok: false, reason: 'navigate_off_domain', step: step.index };
        steps.push({ op: 'goto', url });
        break;
      }
      case 'click': {
        const t = step.semanticTarget;
        const role = t?.role;
        const name = t?.name.replace(/\s+/g, ' ').trim() ?? '';
        if (role === undefined || !(HYBRID_CLICK_ROLES as readonly string[]).includes(role) || name === '' || name.length > MAX_NAME) {
          return { ok: false, reason: 'missing_target', step: step.index };
        }
        steps.push({ op: 'click', target: { role: role as (typeof HYBRID_CLICK_ROLES)[number], name } });
        break;
      }
      case 'type':
        return { ok: false, reason: 'unsupported_action', step: step.index };
      case 'scroll':
      case 'read':
      case 'done':
        break;
    }
  }
  return { ok: true, steps };
}
