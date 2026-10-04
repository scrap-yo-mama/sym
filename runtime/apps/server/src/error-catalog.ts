// SPDX-License-Identifier: AGPL-3.0-only
// Catalogue d'erreurs du serveur (UX-09, U1.5, 03-specs-mcp § 8 et § 10.3) : pour chaque code, le message et l'action pour
// l'humain dans sa langue (`srv.error.<code>`, `srv.errorAction.<code>`), la marche à suivre pour le modèle en anglais
// (`what_to_do`, dérivée du texte anglais) et `retryable`. REST (crochet `onSend`) et MCP (`toolError`) lisent le même
// catalogue : une erreur dit la même chose sur les deux canaux. Jamais un texte du site ni une valeur reçue : seuls les
// paramètres nommés par la route (`scope`, `field`, `n`, `reason`, `class`) entrent dans un message.
import { defaultI18n } from '@runtime/i18n';

export type ErrorTexts = {
  /** Message dans la langue demandée, ou null si le code n'a pas d'entrée au catalogue. */
  message: string | null;
  action_label: string;
  what_to_do: string;
  retryable: boolean;
};

/** Codes dont l'appel peut être refait tel quel après un délai, ou après correction de l'entrée par l'appelant. */
const RETRYABLE = new Set([
  'not_ready',
  'queue_full',
  'user_queue_full',
  'key_rate_limited',
  'too_many_streams',
  'too_many_attempts',
  'internal',
  'idp_unreachable',
  'investigation_in_progress',
  'invalid_input',
  'invalid_request',
  'invalid_cursor',
  'invalid_fields',
  'invalid_schema',
  'invalid_brief',
  'brief_too_large',
  'secret_in_brief',
  'url_not_allowed',
  'ssrf_blocked',
  'prerequisites_missing',
  'llm_settings_unreadable',
  'llm_model_missing',
  'instance_contact_missing',
  'llm_price_missing',
  'minimal_content',
]);

/** `retryable` d'un code : la liste ci-dessus, ou tout statut 429 et 5xx. */
export function isRetryable(code: string, status?: number): boolean {
  return RETRYABLE.has(code) || (status !== undefined && (status === 429 || status >= 500));
}

/** Paramètres de message : seules des valeurs scalaires courtes (jamais un objet, jamais un texte long du site). */
export type ErrorParams = Readonly<Record<string, unknown>>;

function scalars(params: ErrorParams): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string') out[key] = value.slice(0, 80);
  }
  return out;
}

/** Code connu du catalogue (message présent en anglais, la langue source). */
export function hasErrorCode(code: string): boolean {
  return defaultI18n().renderer.has(`srv.error.${code}`, 'en');
}

/** Textes d'un code dans une langue. Un code inconnu garde une action générique et une marche à suivre non vides. */
export function errorTexts(code: string, locale: string, params: ErrorParams = {}, status?: number): ErrorTexts {
  const { renderer } = defaultI18n();
  const p = scalars(params);
  const known = renderer.has(`srv.error.${code}`, 'en');
  const messageKey = `srv.error.${code}`;
  const actionKey = renderer.has(`srv.errorAction.${code}`, 'en') ? `srv.errorAction.${code}` : 'srv.errorAction.generic';
  const message = known ? renderer.render(messageKey, p, locale) : null;
  const action = renderer.render(actionKey, p, locale);
  const english = known ? renderer.render(messageKey, p, 'en') : renderer.render('srv.unknown_code', { code }, 'en');
  const englishAction = renderer.render(actionKey, p, 'en');
  return { message, action_label: action, what_to_do: `${english} ${englishAction}.`, retryable: isRetryable(code, status) };
}
