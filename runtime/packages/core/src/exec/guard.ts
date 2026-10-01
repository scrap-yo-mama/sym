// SPDX-License-Identifier: AGPL-3.0-only
// Garde de classification AVANT réparation (tâche 1.7, 04 §5 et §7, INV6) : la suite de chaque classe d'échec, et la
// seule porte par laquelle un agent (réparation, E4-E6) peut être invoqué après un échec.
// - Refus et défis (`blocked_by_protection`, `forbidden`, `robots_disallowed`) : arrêt, aucun agent, aucun changement
//   de réseau ; statut `bloquee`. Jamais de proposition du tunnel (A7, X3) : aucune suite ne le nomme.
// - `auth_required`, `payment_required`, `account_limit` : la main revient à l'utilisateur (`action_requise`).
// - Seules `extraction`, `code_error` et `not_found` (réparation limitée à retrouver l'URL) ouvrent l'agent, et
//   seulement si aucune preuve transmise n'est une page de défi ou un refus : sinon la classe est corrigée en
//   `blocked_by_protection` et l'agent n'est pas appelé. Sur une réponse 2xx, seul un signal fort reclasse ; un signal
//   faible garde la classe et retire la preuve de ce que l'agent reçoit. Aucune page de défi n'entre dans un prompt
//   (`assertPromptSafe`).
import type { FailureClass } from '../model/enums.js';
import { networkDecision, type NetworkDecision } from '../net/modes/ladder.js';
import { classifyExchange } from './classify.js';
import { challengeInText } from './protection.js';
import type { ExecFailure, HttpExchange } from './types.js';

/** Suite d'un échec (colonne « Suite » de 04 §7). */
export type FailureNext =
  /** Réessais avec délai et jitter, puis indisponibilité (`transient`), ou réessai / repli de modèle (`llm_*`). */
  | 'retry'
  /** Réparation dans le même run (agent), puis autre E. */
  | 'repair'
  /** Couple suivant avec un autre N, si autorisé (`network` seulement). */
  | 'next_network'
  /** Ralentir sur la même IP ; disjoncteur du domaine. */
  | 'slow_down'
  /** Arrêt de toute escalade. */
  | 'stop'
  /** La main revient à l'utilisateur. */
  | 'action_required'
  /** robots.txt injoignable : on s'abstient (RFC 9309). */
  | 'abstain';

export type FailureRoute = {
  readonly next: FailureNext;
  /** Vrai seulement si un agent (réparation) peut être invoqué pour cette classe. */
  readonly agent: boolean;
  /** Suite sur l'axe réseau (même table que l'échelle N1-N3 de 1.4). */
  readonly network: NetworkDecision;
  /** Statut d'API visé par la suite, quand la classe en impose un (04 §6). */
  readonly status: 'bloquee' | 'action_requise' | 'erreur' | 'warning' | null;
};

/** `llm_*` sans repli de modèle (04 §7). */
const LLM_NO_FALLBACK = new Set(['llm_refused', 'llm_auth', 'llm_quota_exhausted']);

const route = (next: FailureNext, agent: boolean, status: FailureRoute['status'], cls: FailureClass): FailureRoute => ({
  next,
  agent,
  network: networkDecision(cls),
  status,
});

/** Suite d'une classe d'échec. Table fermée : toute classe hors 04 §7 est traitée comme un arrêt sans agent. */
export function failureRoute(cls: FailureClass): FailureRoute {
  switch (cls) {
    case 'blocked_by_protection':
    case 'forbidden':
    case 'robots_disallowed':
      return route('stop', false, 'bloquee', cls);
    case 'auth_required':
    case 'payment_required':
    case 'account_limit':
      return route('action_required', false, 'action_requise', cls);
    case 'rate_limited':
      return route('slow_down', false, null, cls);
    case 'transient':
      return route('retry', false, 'warning', cls);
    case 'network':
      return route('next_network', false, null, cls);
    case 'robots_unreachable':
      return route('abstain', false, 'erreur', cls);
    case 'extraction':
    case 'code_error':
    case 'not_found':
      return route('repair', true, null, cls);
    case 'run_budget_exceeded':
    case 'budget_exceeded':
      return route('stop', false, null, cls);
    default:
      return route(LLM_NO_FALLBACK.has(cls) ? 'stop' : 'retry', false, null, cls);
  }
}

/** Refus de la garde : la classe corrigée (ou d'origine) qui interdit l'agent. */
export class ClassificationGuardError extends Error {
  readonly failure: ExecFailure;
  constructor(failure: ExecFailure) {
    super(`garde de classification : ${failure.failure_class} (${failure.detail})`);
    this.name = 'ClassificationGuardError';
    this.failure = failure;
  }
}

/** Preuve transmise à un agent : un échange HTTP, ou du texte (instantané, journal masqué). */
export type AgentEvidence = HttpExchange | string;

const CHALLENGE_TEXT: ExecFailure = { failure_class: 'blocked_by_protection', retryable: false, detail: 'challenge_page' };

/**
 * Verdict sur une preuve : un refus (classe qui interdit l'agent), `withhold` (signal de défi faible sur une réponse 2xx :
 * l'échec garde sa classe, mais la preuve n'est pas montrée à l'agent), ou `show`.
 * Sur une réponse 2xx, seul un signal FORT reclasse (mode strict de `classifyExchange`) : sinon une API saine dont la
 * page cite « I'm not a robot » ou porte un formulaire de contact protégé passerait `bloquee` sans réparation.
 */
function evidenceVerdict(evidence: AgentEvidence): ExecFailure | 'withhold' | 'show' {
  if (typeof evidence === 'string') return challengeInText(evidence) ? CHALLENGE_TEXT : 'show';
  const failure = classifyExchange(evidence);
  if (failure !== null && !failureRoute(failure.failure_class).agent) return failure;
  if (!challengeInText(evidence.body)) return 'show';
  return evidence.status >= 200 && evidence.status < 300 ? 'withhold' : { ...CHALLENGE_TEXT, status: evidence.status };
}

/** Garde sur les preuves : la classe qui interdit l'agent, ou les preuves qu'il peut recevoir (signaux faibles retirés). */
export type EvidenceScreen = { readonly refusal: ExecFailure } | { readonly refusal: null; readonly evidence: readonly AgentEvidence[] };

/**
 * Garde avant tout appel d'agent après un échec, avec les preuves que l'agent peut recevoir : refus d'origine, refus
 * corrigé d'après une preuve (une « extraction » sur une page de défi est un refus), ou preuves filtrées.
 */
export function screenAgentEvidence(failure: ExecFailure, evidence: readonly AgentEvidence[] = []): EvidenceScreen {
  if (!failureRoute(failure.failure_class).agent) return { refusal: failure };
  const shown: AgentEvidence[] = [];
  for (const item of evidence) {
    const verdict = evidenceVerdict(item);
    if (verdict === 'show') shown.push(item);
    else if (verdict !== 'withhold') return { refusal: verdict };
  }
  return { refusal: null, evidence: shown };
}

/**
 * Garde avant tout appel d'agent après un échec : `null` si l'agent peut être invoqué, sinon la classe qui l'interdit
 * (d'origine, ou corrigée d'après les preuves : une « extraction » sur une page de défi est un refus).
 */
export function guardAgentInvocation(failure: ExecFailure, evidence: readonly AgentEvidence[] = []): ExecFailure | null {
  return screenAgentEvidence(failure, evidence).refusal;
}

/**
 * Invoque l'agent seulement si la garde le permet, avec les SEULES preuves qu'elle laisse passer ; sinon rend la classe
 * retenue, sans appel.
 */
export async function invokeAgentGuarded<T>(
  failure: ExecFailure,
  evidence: readonly AgentEvidence[],
  invoke: (failure: ExecFailure, evidence: readonly AgentEvidence[]) => Promise<T>,
): Promise<{ readonly invoked: true; readonly value: T } | { readonly invoked: false; readonly failure: ExecFailure }> {
  const screen = screenAgentEvidence(failure, evidence);
  if (screen.refusal !== null) return { invoked: false, failure: screen.refusal };
  return { invoked: true, value: await invoke(failure, screen.evidence) };
}

/** Garde des prompts : lève `ClassificationGuardError` si le texte est une page de défi (il n'entre dans aucun prompt). */
export function assertPromptSafe(text: string): void {
  if (challengeInText(text)) throw new ClassificationGuardError(CHALLENGE_TEXT);
}
