// SPDX-License-Identifier: AGPL-3.0-only
// Erreurs typées de l'API (cdc/sym-browser 04 § 6) : `{ error: { code, message, retryable, what_to_do, requestId, details } }`,
// statut HTTP du contrat (`ERROR_STATUS`), `what_to_do` en français (tutoiement) ou en anglais selon `Accept-Language`.
// `Retry-After` (secondes) sur les 429 et 503. `message` est une phrase technique en anglais, sans donnée sensible.
import { ERROR_STATUS, type ApiError, type ErrorCode } from '@sym/contracts/browser';

type Lang = 'fr' | 'en';

const WHAT_TO_DO: Record<ErrorCode, Record<Lang, string>> = {
  unauthorized: {
    fr: 'Envoie une clé d’API valide en en-tête Authorization: Bearer.',
    en: 'Send a valid API key in the Authorization: Bearer header.',
  },
  forbidden: { fr: 'Utilise une clé d’API qui porte le scope indiqué dans details.', en: 'Use an API key with the scope listed in details.' },
  session_not_found: { fr: 'Vérifie l’identifiant de la session.', en: 'Check the session id.' },
  profile_locked: { fr: 'Attends la fin de l’autre session ou ouvre le profil en lecture.', en: 'Wait for the other session to end or open the profile read-only.' },
  session_id_taken: { fr: 'Choisis un autre id pour la session.', en: 'Choose another session id.' },
  idempotency_conflict: { fr: 'Utilise une nouvelle Idempotency-Key pour une demande différente.', en: 'Use a new Idempotency-Key for a different request.' },
  protocol_not_served: { fr: 'Crée la session en type dedicated pour la piloter en CDP.', en: 'Create the session with type dedicated to drive it over CDP.' },
  invalid_option: { fr: 'Corrige le champ indiqué dans details.', en: 'Fix the field listed in details.' },
  playwright_version_mismatch: { fr: 'Installe playwright-core 1.63.x (voir GET /v1/version).', en: 'Install playwright-core 1.63.x (see GET /v1/version).' },
  quota_exceeded: { fr: 'Attends Retry-After ou libère une session.', en: 'Wait for Retry-After or release a session.' },
  capacity_exceeded: { fr: 'Réessaie après Retry-After.', en: 'Retry after Retry-After.' },
  proxy_unreachable: { fr: 'Vérifie le proxy amont et ses identifiants.', en: 'Check the upstream proxy and its credentials.' },
  no_node: { fr: 'Réessaie dans un instant ; l’admin peut ajouter un nœud.', en: 'Retry shortly; the admin can add a node.' },
};

const RETRYABLE = new Set<ErrorCode>(['profile_locked', 'quota_exceeded', 'capacity_exceeded', 'proxy_unreachable', 'no_node']);

/** Langue de `what_to_do` : français si `Accept-Language` le préfère, anglais sinon. */
export function preferredLanguage(acceptLanguage: string | undefined): Lang {
  if (!acceptLanguage) return 'en';
  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag: tag.toLowerCase(), q: q === undefined ? 1 : Number(q) };
    })
    .filter((entry) => entry.q > 0 && (entry.tag.startsWith('fr') || entry.tag.startsWith('en')))
    .sort((a, b) => b.q - a.q);
  return ranked[0]?.tag.startsWith('fr') === true ? 'fr' : 'en';
}

export class ApiProblem extends Error {
  readonly code: ErrorCode;
  readonly details: ApiError['error']['details'] | undefined;
  readonly retryAfter: number | undefined;
  constructor(code: ErrorCode, message: string, options: { details?: ApiError['error']['details']; retryAfter?: number } = {}) {
    super(message);
    this.code = code;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
  }

  get status(): number {
    return ERROR_STATUS[this.code];
  }

  body(requestId: string, lang: Lang): ApiError {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: RETRYABLE.has(this.code),
        what_to_do: WHAT_TO_DO[this.code][lang],
        requestId,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export type InvalidField = { field: string; reason: string };

export const invalidOption = (details: InvalidField[]): ApiProblem => new ApiProblem('invalid_option', 'Invalid session option.', { details });
