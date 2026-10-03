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
};

/** Cause d'un run terminé en échec (`failed`), ou null si elle n'est pas nommée. */
export function runErrorOf(run: { state: string; error_detail?: string | null }): RunError | null {
  if (run.state !== 'failed' || typeof run.error_detail !== 'string') return null;
  const known = RUN_ERRORS[run.error_detail];
  return known === undefined ? null : { code: run.error_detail, ...known };
}

/** Refus de création (`create_api`) quand le prérequis manque : même texte que la cause d'un run. */
export function runErrorFor(code: keyof typeof RUN_ERRORS): RunError {
  return { code, ...RUN_ERRORS[code]! };
}
