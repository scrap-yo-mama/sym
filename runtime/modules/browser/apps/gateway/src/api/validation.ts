// SPDX-License-Identifier: AGPL-3.0-only
// Validation des entrées de l'API par les schémas du contrat (`browserOpenApi`, OpenAPI 3.1 = JSON Schema 2020-12) : la
// passerelle refuse exactement ce que le contrat publié refuse (Schemathesis le vérifie), puis applique les contrôles que
// JSON Schema n'exprime pas (langue BCP 47, fuseau IANA), comme le nœud (tâche 1.3). Chaque champ fautif est nommé
// (`launchArgs[0]`, `viewport.height`, `metadata.k`) dans `details` de la 422 `invalid_option`.
import { browserOpenApi, type CreateSessionRequest, type ExtendSessionRequest } from '@sym/contracts/browser';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import { invalidOption, type InvalidField } from './errors.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Date-heure RFC 3339 avec fuseau (format `date-time` d'OpenAPI). */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

export function isDateTime(value: string): boolean {
  return DATE_TIME.test(value) && !Number.isNaN(Date.parse(value));
}

const ajv = new Ajv2020({ strict: false, allErrors: true, useDefaults: false });
ajv.addFormat('uuid', UUID);
ajv.addFormat('date-time', { type: 'string', validate: isDateTime });
ajv.addSchema({ $id: 'https://sym-browser.invalid/openapi.json', ...browserOpenApi });

const compile = <T>(name: keyof typeof browserOpenApi.components.schemas): ValidateFunction<T> =>
  ajv.compile<T>({ $ref: `https://sym-browser.invalid/openapi.json#/components/schemas/${name}` });

const createSession = compile<CreateSessionRequest>('CreateSessionRequest');
const extendSession = compile<ExtendSessionRequest>('ExtendSessionRequest');

/** `/launchArgs/0` → `launchArgs[0]` ; `/viewport` + `height` manquant → `viewport.height`. */
function fieldOf(error: ErrorObject): string {
  const segments = error.instancePath.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  const params = error.params as { missingProperty?: string; additionalProperty?: string };
  if (error.keyword === 'required' && params.missingProperty) segments.push(params.missingProperty);
  if (error.keyword === 'additionalProperties' && params.additionalProperty) segments.push(params.additionalProperty);
  return segments.reduce((path, segment) => (/^\d+$/.test(segment) ? `${path}[${segment}]` : path === '' ? segment : `${path}.${segment}`), '');
}

function details(errors: ErrorObject[] | null | undefined): InvalidField[] {
  const seen = new Set<string>();
  const out: InvalidField[] = [];
  for (const error of errors ?? []) {
    // Les sous-erreurs d'un `oneOf`/`anyOf` répètent le même champ : une seule entrée par champ.
    const field = fieldOf(error);
    if (seen.has(field)) continue;
    seen.add(field);
    out.push({ field, reason: error.message ?? error.keyword });
  }
  return out;
}

function validLocale(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Chaînes que PostgreSQL ne sait pas garder en `jsonb` (U+0000, moitié de paire de substitution UTF-16) : refusées par
 * une 422 qui nomme le champ, au lieu d'une erreur de la base. Clés et valeurs, à toute profondeur.
 */
function unstorableStrings(value: unknown, path = ''): InvalidField[] {
  const bad = (text: string): boolean => text.includes('\u0000') || !text.isWellFormed();
  const join = (key: string): string => (/^\d+$/.test(key) ? `${path}[${key}]` : path === '' ? key : `${path}.${key}`);
  if (typeof value === 'string') return bad(value) ? [{ field: path, reason: 'unsupported character (U+0000 or lone surrogate)' }] : [];
  if (Array.isArray(value)) return value.flatMap((item, index) => unstorableStrings(item, join(String(index))));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      bad(key) ? [{ field: path === '' ? '(key)' : `${path}.(key)`, reason: 'unsupported character (U+0000 or lone surrogate)' }] : unstorableStrings(item, join(key)),
    );
  }
  return [];
}

export function parseCreateSession(body: unknown): CreateSessionRequest {
  const input = body === undefined ? {} : body;
  const unstorable = unstorableStrings(input);
  if (unstorable.length > 0) throw invalidOption(unstorable);
  if (!createSession(input)) throw invalidOption(details(createSession.errors));
  const problems: InvalidField[] = [];
  if (input.locale !== undefined && !validLocale(input.locale)) problems.push({ field: 'locale', reason: 'must be a BCP 47 language tag' });
  if (input.timezoneId !== undefined && !validTimeZone(input.timezoneId)) problems.push({ field: 'timezoneId', reason: 'must be an IANA time zone' });
  // Mots de passe de proxy : chiffrés au repos (BINV6) par l'enveloppe de la tâche 0.3, branchée avec les proxys amont (1.6).
  const upstream = input.egress?.upstream as { password?: unknown } | undefined;
  if (upstream?.password !== undefined) problems.push({ field: 'egress.upstream.password', reason: 'inline proxy credentials are not accepted yet: use a proxy profile' });
  if (problems.length > 0) throw invalidOption(problems);
  return input;
}

export function parseExtendSession(body: unknown): ExtendSessionRequest {
  if (!extendSession(body)) throw invalidOption(details(extendSession.errors));
  return body;
}
