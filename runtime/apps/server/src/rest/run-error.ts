// SPDX-License-Identifier: AGPL-3.0-only
// Cause lisible d'un run arrêté ou en échec (UX-04, 05 § 4.3) : la cause stable (`error_detail` du run, code de raison de
// 04/06), un message pour l'humain, la marche à suivre pour l'agent (`what_to_do`, en anglais comme le reste du MCP) et
// `retryable`. Sans cette cause, l'agent ne lisait que « The run failed (code_error) » alors que la tâche à faire (renseigner
// le contact du robot) est connue. Seules les causes nommées ici sont publiées ; tout autre détail reste hors de la réponse.

export type RunError = { code: string; message: string; what_to_do: string; retryable: boolean };

/** Causes stables dont l'issue est une tâche pour l'opérateur ou l'agent. */
const RUN_ERRORS: Record<string, Omit<RunError, 'code'>> = {
  instance_contact_missing: {
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
};

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
  const known = RUN_ERRORS[code];
  if (known === undefined) return null;
  // `llm_price_missing` nu : le modèle a déjà été appelé (cause propre, texte propre).
  if (code === 'llm_price_missing' && detail === code) return { code, ...LLM_PRICE_UNKNOWN_AFTER_CALL };
  const suffix = detail.slice(code.length + 1);
  const model = detail.startsWith(`${code}:`) && MODEL_NAME.test(suffix) && !/^[a-z]+:\/\//i.test(suffix) ? suffix : null;
  const fill = (text: string) => text.replaceAll('{model}', model ?? (text.startsWith('Renseigne') ? 'utilisé' : 'used'));
  return { code, message: fill(known.message), what_to_do: fill(known.what_to_do), retryable: known.retryable };
}

/**
 * Vrai si la cause nommée a arrêté le run AVANT tout appel (contact absent, prix absent relevé avant l'envoi) : seule la
 * phrase « could not start » lui convient. Un run qui a déjà appelé le modèle (`llm_price_missing` nu) a démarré.
 */
export function runNotStarted(run: { state: string; error_detail?: string | null }): boolean {
  if (runErrorOf(run) === null) return false;
  return run.error_detail !== 'llm_price_missing';
}

/** Cause d'un run terminé en échec (`failed`), ou null si elle n'est pas nommée. */
export function runErrorOf(run: { state: string; error_detail?: string | null }): RunError | null {
  if (run.state !== 'failed' || typeof run.error_detail !== 'string') return null;
  // Un détail `code:modèle` (UX-11) nomme le modèle ; tout autre détail non listé reste hors de la réponse.
  return describe(run.error_detail.split(':', 1)[0]!, run.error_detail);
}

/** Refus de création (`create_api`) quand le prérequis manque : même texte que la cause d'un run. */
export function runErrorFor(code: keyof typeof RUN_ERRORS): RunError {
  return describe(code, code)!;
}
