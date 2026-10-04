// SPDX-License-Identifier: AGPL-3.0-only
// Cause lisible d'un run arrêté ou en échec (UX-04, 05 § 4.3) : la cause stable (code de raison de 04/06), un message pour
// l'humain, la marche à suivre pour l'agent (`what_to_do`, en anglais comme le reste du MCP) et `retryable`. Sans cette cause,
// l'agent ne lisait que « The run failed (code_error) » alors que la tâche à faire (renseigner le contact du robot) est connue.
// Seules les causes nommées ici sont publiées ; tout autre détail reste hors de la réponse.

export type RunError = { code: string; message: string; what_to_do: string; retryable: boolean };

/**
 * Causes stables dont l'issue est une tâche pour l'opérateur ou l'agent, indexées par le détail du run (`error_detail`). Un
 * contact posé mais illisible (UX-05) porte la même raison que le contact absent : dans les deux cas, aucun contact utilisable ;
 * seul le message change (« corrige » au lieu de « renseigne »).
 */
const RUN_ERRORS: Record<string, Omit<RunError, 'code'> & { code?: string; investigation?: true; started?: true }> = {
  instance_contact_missing: {
    code: 'instance_contact_missing',
    message: 'Renseigne le contact du robot dans Réglages > Identité du robot, ou la variable INSTANCE_CONTACT.',
    what_to_do:
      'Ask the user to set the robot contact in the console (Settings > Robot identity, /settings/robot) or the INSTANCE_CONTACT variable of the server, then call again: nothing was fetched and nothing was spent.',
    retryable: true,
  },
  // UX-11/UX-12 : le prix du modèle n'est réglé que dans Réglages > Modèles IA. Détail `llm_price_missing:<modèle>` : l'enquête
  // s'arrête AVANT tout appel (0 €, jamais compté comme 0) ; `{model}` vaut le modèle nommé.
  llm_price_missing: {
    message: 'Renseigne le prix du modèle {model} dans Réglages > Modèles IA.',
    what_to_do:
      'Ask the user to enter the price of model {model} (USD per million tokens: input, output, optional cached input) in the console (Settings > AI models, /settings/models), then call again: no model call was made and nothing was spent.',
    retryable: true,
  },
  instance_contact_invalid: {
    code: 'instance_contact_missing',
    message: 'Le contact du robot est invalide : corrige-le dans Réglages > Identité du robot, ou corrige la variable INSTANCE_CONTACT (adresse e-mail ou URL http(s)).',
    what_to_do:
      'Ask the user to fix the robot contact (an e-mail address or an http(s) URL) in the console (Settings > Robot identity, /settings/robot) or the INSTANCE_CONTACT variable, then call again: nothing was fetched and nothing was spent.',
    retryable: true,
  },
  // D-123 : run d'une API sans plafond par run, coupé par sa borne, le budget du jour restant de l'utilisateur.
  user_budget_daily_usd: {
    code: 'budget_exceeded',
    message: "Le budget du jour de ce compte est atteint (coûts LLM et proxy) : le run s'est arrêté. Il se réinitialise à minuit UTC ; un admin peut le relever (USER_BUDGET_DAILY_USD).",
    what_to_do:
      'The daily USD budget of this account ran out during the run (LLM and proxy costs), so the run stopped. Do not retry today: tell the user it resets at 00:00 UTC and that an admin can raise it (USER_BUDGET_DAILY_USD). Costs already incurred remain charged.',
    retryable: false,
    started: true,
  },
};

/**
 * Fins d'échec d'une enquête qui ont démarré (constats UX-29, UX-32) : même code que la raison de statut (transition 2),
 * la suite proposée pour l'agent. Le récit (`get_run`) donne chaque essai et son motif.
 */
Object.assign(RUN_ERRORS, {
  trial_cost_over_cap: {
    code: 'trial_cost_over_cap',
    message: "Un essai coûte plus que le plafond par run fixé sur l'API (max_cost_usd) : relève ce plafond ou retire-le (aucun plafond par défaut), puis ré-enquête.",
    what_to_do:
      "A trial needed more than the per-run cost cap set on this API (max_cost_usd) and was stopped; the investigation budget was not used up. Show the user the cost of each trial (timeline), ask whether to raise that cap or remove it (no per-run cap is the default) in the API settings (console), then investigate again (run_api with force_investigate).",
    retryable: false,
    investigation: true,
  },
  no_conformant_strategy: {
    code: 'no_conformant_strategy',
    message: "Aucun essai n'a rendu d'items conformes : la chronologie donne chaque essai et son motif.",
    what_to_do:
      'No trial returned items that match the output schema. Read each trial and its reason in the timeline (get_run), tell the user, then either adjust the description or the schema and investigate again (run_api with force_investigate), or report_problem.',
    retryable: false,
    investigation: true,
  },
  investigation_budget_usd: {
    code: 'investigation_budget_exhausted',
    message: "Le budget d'enquête est dépensé sans stratégie conforme : monte budget_usd pour ré-enquêter.",
    what_to_do: 'The investigation budget (budget_usd) is spent without a conformant strategy. Ask the user whether to investigate again with a higher budget_usd (run_api with force_investigate).',
    retryable: false,
    investigation: true,
  },
  investigation_timeout_s: {
    code: 'investigation_timeout',
    message: "La durée d'enquête est écoulée sans stratégie conforme : monte timeout_s pour ré-enquêter.",
    what_to_do: 'The investigation time (timeout_s) ran out without a conformant strategy. Ask the user whether to investigate again with a longer timeout_s (run_api with force_investigate).',
    retryable: false,
    investigation: true,
  },
});

export type RunErrorDetail = 'instance_contact_missing' | 'instance_contact_invalid' | 'llm_price_missing';

/**
 * Détail `llm_price_missing` SANS modèle : le run (hors enquête, ou enquête après l'appel) a appelé le modèle, des jetons ont
 * été consommés chez le fournisseur, mais le coût est inconnu (null, jamais 0 : 08 § 1, INV4). Jamais « aucun appel ».
 */
const LLM_PRICE_UNKNOWN_AFTER_CALL: Omit<RunError, 'code'> = {
  message: 'Le coût du run est inconnu : renseigne le prix du modèle utilisé dans Réglages > Modèles IA.',
  what_to_do:
    'The model was called but its cost is unknown (null, not zero): tokens were consumed at the provider and are not counted in the run cost. Ask the user to enter the price of the model used (USD per million tokens: input, output, optional cached input) in the console (Settings > AI models, /settings/models), then call again.',
  retryable: true,
};

/** Nom de modèle publiable (identifiants de fournisseurs : `claude-opus-4-8`, `zai-org/GLM-5.3`, `qwen3:8b`) : jamais un détail libre (INV8). */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function describe(code: string, detail: string): RunError | null {
  const known = Object.hasOwn(RUN_ERRORS, code) ? RUN_ERRORS[code] : undefined;
  if (known === undefined) return null;
  // `llm_price_missing` nu : le modèle a déjà été appelé (cause propre, texte propre).
  if (code === 'llm_price_missing' && detail === code) return { code, ...LLM_PRICE_UNKNOWN_AFTER_CALL };
  const suffix = detail.slice(code.length + 1);
  const model = detail.startsWith(`${code}:`) && MODEL_NAME.test(suffix) && !/^[a-z]+:\/\//i.test(suffix) ? suffix : null;
  const fill = (text: string) => text.replaceAll('{model}', model ?? (text.startsWith('Renseigne') ? 'utilisé' : 'used'));
  return { code: known.code ?? code, message: fill(known.message), what_to_do: fill(known.what_to_do), retryable: known.retryable };
}

/**
 * Vrai si la cause nommée a arrêté le run AVANT tout appel (contact absent, prix absent relevé avant l'envoi) : seule la
 * phrase « could not start » lui convient. Un run qui a déjà appelé le modèle (`llm_price_missing` nu) a démarré.
 */
export function runNotStarted(run: { state: string; error_detail?: string | null }): boolean {
  if (runErrorOf(run) === null || runInvestigationFailed(run)) return false;
  if (RUN_ERRORS[run.error_detail!.split(':', 1)[0]!]?.started === true) return false;
  return run.error_detail !== 'llm_price_missing';
}

/** Vrai si la cause nommée est une fin d'échec d'enquête démarrée (plafond d'essai, aucune conforme, budget, durée). */
export function runInvestigationFailed(run: { state: string; error_detail?: string | null }): boolean {
  if (runErrorOf(run) === null || typeof run.error_detail !== 'string') return false;
  return RUN_ERRORS[run.error_detail.split(':', 1)[0]!]?.investigation === true;
}

/** Cause d'un run terminé en échec (`failed`), ou null si elle n'est pas nommée. */
export function runErrorOf(run: { state: string; error_detail?: string | null }): RunError | null {
  if (run.state !== 'failed' || typeof run.error_detail !== 'string') return null;
  // Un détail `code:modèle` (UX-11) nomme le modèle ; tout autre détail non listé reste hors de la réponse.
  return describe(run.error_detail.split(':', 1)[0]!, run.error_detail);
}

/** Refus de création (`create_api`) quand le prérequis manque : même texte que la cause d'un run. */
export function runErrorFor(code: RunErrorDetail): RunError {
  return describe(code, code)!;
}
