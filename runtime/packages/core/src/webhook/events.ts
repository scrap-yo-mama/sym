// SPDX-License-Identifier: AGPL-3.0-only
// Événements sortants (08 § 5) : noms, charges utiles minces, barème de relance. INV5 : la charge ne porte jamais d'item,
// seulement des identifiants, des compteurs et l'URL du dataset ; les items restent derrière la clé d'API.
import type { ApiStatus, FailureClass } from '../model/enums.js';
import { BLOCKING_CLASSES } from '../status/types.js';

export const WEBHOOK_EVENTS = ['run.succeeded', 'run.failed', 'api.status_changed', 'items.new'] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

export function isWebhookEvent(value: unknown): value is WebhookEventName {
  return typeof value === 'string' && (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/** Succès = 2xx en 15 s. */
export const WEBHOOK_TIMEOUT_MS = 15_000;

/** Délai avant chaque tentative (s) : immédiat, 5 s, 5 min, 30 min, 2 h (à valider ; barème étendu en V2). */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [0, 5, 300, 1800, 7200] as const;
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SECONDS.length;

/** Une cible passe `disabled` après 5 jours d'échecs continus. */
export const WEBHOOK_DISABLE_AFTER_MS = 5 * 24 * 3_600_000;

/**
 * Une série d'échecs n'est « continue » que si deux échecs ne sont jamais séparés de plus de 24 h : un échec isolé il y a
 * 6 jours suivi d'un nouvel échec ouvre une nouvelle série, il ne désactive pas la cible.
 */
export const WEBHOOK_FAILURE_SERIES_GAP_MS = 24 * 3_600_000;

/** Délai (s) avant la tentative `attempt` (1 = première). `null` : barème épuisé. */
export function webhookDelaySeconds(attempt: number): number | null {
  return WEBHOOK_RETRY_DELAYS_SECONDS[attempt - 1] ?? null;
}

export type WebhookPayload = {
  type: WebhookEventName;
  timestamp: string;
  data: Record<string, unknown>;
};

/**
 * Champs qui ne figurent JAMAIS dans la charge d'un webhook signé (21 § 4.4, u6 R24, M10) : une phrase n'y a pas sa place. La charge
 * ne porte que des codes, des paramètres, des identifiants et des horodatages ISO 8601 UTC ; la table des codes est publiée dans la doc.
 */
export const WEBHOOK_FORBIDDEN_FIELDS = ['message', 'text', 'description'] as const;

/** Schéma JSON de la charge d'un webhook : interdit `message`, `text` et `description` à toute profondeur (`assert_webhook_payload_has_no_sentences`). */
export const WEBHOOK_PAYLOAD_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['type', 'timestamp', 'data'],
  properties: {
    type: { enum: [...WEBHOOK_EVENTS] },
    timestamp: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$' },
    data: { $ref: '#/$defs/plain' },
  },
  $defs: {
    plain: { type: 'object', propertyNames: { not: { enum: [...WEBHOOK_FORBIDDEN_FIELDS] } }, additionalProperties: { $ref: '#/$defs/value' } },
    value: { anyOf: [{ type: ['string', 'number', 'boolean', 'null'] }, { type: 'array', items: { $ref: '#/$defs/value' } }, { $ref: '#/$defs/plain' }] },
  },
} as const;

/** Refuse une charge qui porte un champ de phrase (à toute profondeur) ; renvoie la charge telle quelle sinon. */
export function assertNoSentenceFields(payload: WebhookPayload): WebhookPayload {
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) return value.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (typeof value !== 'object' || value === null) return;
    for (const [key, inner] of Object.entries(value)) {
      if ((WEBHOOK_FORBIDDEN_FIELDS as readonly string[]).includes(key)) throw new Error(`charge de webhook : le champ « ${path}.${key} » est interdit (codes et paramètres seulement)`);
      walk(inner, `${path}.${key}`);
    }
  };
  walk(payload.data, 'data');
  return payload;
}

type ApiRef = { api: string; api_id: string };
type RunRef = ApiRef & { run_id: string; status: ApiStatus; trigger?: string };

const datasetUrl = (baseUrl: string | null | undefined, datasetId: string | null | undefined): Record<string, string> =>
  baseUrl && datasetId ? { dataset_url: `${baseUrl.replace(/\/+$/, '')}/api/datasets/${datasetId}/items` } : {};

export function runSucceededPayload(
  at: Date,
  input: RunRef & { items: number; items_rejected?: number; new_items?: number; outcome: string; dataset_id?: string | null; base_url?: string | null },
): WebhookPayload {
  return assertNoSentenceFields({
    type: 'run.succeeded',
    timestamp: at.toISOString(),
    data: {
      api: input.api,
      api_id: input.api_id,
      run_id: input.run_id,
      status: input.status,
      outcome: input.outcome,
      items: input.items,
      // Items extraits non conformes, écartés et jamais livrés (D-49, 04 §5) : un compteur, jamais une valeur.
      items_rejected: input.items_rejected ?? 0,
      ...(input.new_items === undefined ? {} : { new_items: input.new_items }),
      ...datasetUrl(input.base_url, input.dataset_id),
    },
  });
}

export function runFailedPayload(
  at: Date,
  input: RunRef & { failure_class: FailureClass | null; retryable: boolean | null },
): WebhookPayload {
  return assertNoSentenceFields({
    type: 'run.failed',
    timestamp: at.toISOString(),
    data: {
      api: input.api,
      api_id: input.api_id,
      run_id: input.run_id,
      status: input.status,
      failure_class: input.failure_class,
      // Classe bloquante (refus, interdit, robots.txt) : jamais « réessayable », quoi que rapporte l'exécuteur (X3, X4).
      retryable: input.failure_class !== null && (BLOCKING_CLASSES as readonly string[]).includes(input.failure_class) ? false : input.retryable,
    },
  });
}

/**
 * `api.status_changed` : `from`, `to`, `reason`. Vers `bloquee`, `retryable: false` : aucune relance automatique n'en
 * découle (un site qui a refusé n'est pas re-sollicité), et la charge ne propose aucune échappatoire réseau.
 */
export function statusChangedPayload(at: Date, input: ApiRef & { from: ApiStatus | null; to: ApiStatus; reason: string | null; run_id?: string | null }): WebhookPayload {
  return assertNoSentenceFields({
    type: 'api.status_changed',
    timestamp: at.toISOString(),
    data: {
      api: input.api,
      api_id: input.api_id,
      from: input.from,
      to: input.to,
      reason: input.reason,
      ...(input.run_id ? { run_id: input.run_id } : {}),
      retryable: input.to !== 'bloquee',
    },
  });
}

export function itemsNewPayload(
  at: Date,
  input: ApiRef & { run_id: string; new_items: number; items: number; dataset_id?: string | null; base_url?: string | null },
): WebhookPayload {
  return assertNoSentenceFields({
    type: 'items.new',
    timestamp: at.toISOString(),
    data: {
      api: input.api,
      api_id: input.api_id,
      run_id: input.run_id,
      new_items: input.new_items,
      items: input.items,
      ...datasetUrl(input.base_url, input.dataset_id),
    },
  });
}

export type DeliveryOutcome = {
  /** `delivered` : 2xx. `retry` : nouvelle tentative au barème. `failed` : abandon (barème épuisé ou échec non rejouable). */
  verdict: 'delivered' | 'retry' | 'failed';
  errorCode: string | null;
  /** Prochaine tentative dans (s), si `retry`. */
  delaySeconds: number | null;
};

/** Classe le résultat d'une tentative. Une redirection ou un refus SSRF n'est jamais rejoué : le résultat serait le même. */
export function classifyDelivery(attempt: number, result: { httpStatus: number | null; error: 'ssrf_blocked' | 'timeout' | 'network' | null }): DeliveryOutcome {
  if (result.error === null && result.httpStatus !== null && result.httpStatus >= 200 && result.httpStatus < 300) {
    return { verdict: 'delivered', errorCode: null, delaySeconds: null };
  }
  let errorCode: string;
  let rejouable = true;
  if (result.error === 'ssrf_blocked') {
    errorCode = 'ssrf_blocked';
    rejouable = false;
  } else if (result.error !== null) {
    errorCode = result.error;
  } else if (result.httpStatus !== null && result.httpStatus >= 300 && result.httpStatus < 400) {
    errorCode = 'redirect_not_followed';
    rejouable = false;
  } else {
    errorCode = `http_${result.httpStatus ?? 0}`;
  }
  const next = rejouable ? webhookDelaySeconds(attempt + 1) : null;
  return next === null ? { verdict: 'failed', errorCode, delaySeconds: null } : { verdict: 'retry', errorCode, delaySeconds: next };
}
