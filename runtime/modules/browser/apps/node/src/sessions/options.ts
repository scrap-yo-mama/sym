// SPDX-License-Identifier: AGPL-3.0-only
// Options d'une session shared (cdc/sym-browser 04 § 3, tâche 1.3) traduites en options de contexte Playwright : viewport,
// locale, fuseau, User-Agent, en-têtes, géolocalisation, thème, téléchargements, storageState. Le nœud revalide tout ce qu'il
// reçoit (la passerelle valide d'abord, tâche 2.2) : un champ inconnu ou invalide est refusé avec son nom (422
// `invalid_option`), jamais ignoré ni transmis tel quel à Playwright. Le proxy du contexte n'est posé que par le nœud
// (egress de la session, 04c § 1.1, tâche 1.5).
import type { CreateSessionRequest } from '@sym/contracts/browser';
import { COLOR_SCHEMES } from '@sym/contracts/browser';
import type { BrowserContextOptions } from 'playwright-core';

/** Options de contexte d'une session shared (sous-ensemble de `CreateSessionRequest`). */
type SharedSessionOptions = Pick<CreateSessionRequest, 'viewport' | 'locale' | 'timezoneId' | 'userAgent' | 'extraHTTPHeaders' | 'geolocation' | 'colorScheme' | 'acceptDownloads' | 'storageState'>;

/** Champs reçus par le nœud : les options shared, plus ceux qui imposent `dedicated` (refusés ici, bascule à la création). */
export type SharedSessionInput = SharedSessionOptions & Pick<CreateSessionRequest, 'profile' | 'launchArgs'>;

/** Défauts de l'instance (04 § 3). */
export const SHARED_CONTEXT_DEFAULTS = Object.freeze({
  viewport: Object.freeze({ width: 1280, height: 720 }),
  locale: 'en-US',
  timezoneId: 'UTC',
  colorScheme: 'light',
  acceptDownloads: false,
} as const);

export type InvalidOptionDetail = { field: string; reason: string };

/** 422 `invalid_option` (04 § 3 et § 6) : chaque champ fautif nommé dans `details`. */
export class InvalidSessionOptionError extends Error {
  override name = 'InvalidSessionOptionError';
  readonly code = 'invalid_option';
  readonly status = 422;
  readonly details: InvalidOptionDetail[];
  constructor(details: InvalidOptionDetail[]) {
    super(`Option de session invalide : ${details.map((d) => `${d.field} (${d.reason})`).join(', ')}.`);
    this.details = details;
  }
}

/** Bornes du viewport (provisoires : 8K au plus, aucune mesure ne les fixe encore). */
const VIEWPORT_MAX = { width: 7680, height: 4320 } as const;
const USER_AGENT_MAX = 512;
const HEADERS_MAX = 64;
const HEADER_VALUE_MAX = 8192;
/** RFC 9110 § 5.6.2 : `token`. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** En-têtes de transport et de proxy : posés par Chromium ou par l'egress, jamais par le client. */
const FORBIDDEN_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'content-length', 'transfer-encoding', 'te', 'trailer', 'upgrade']);
// Caractères de contrôle (C0 et DEL) : interdits dans un User-Agent et dans une valeur d'en-tête.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

const KNOWN = new Set<string>(['viewport', 'locale', 'timezoneId', 'userAgent', 'extraHTTPHeaders', 'geolocation', 'colorScheme', 'acceptDownloads', 'storageState']);
const DEDICATED_ONLY = new Set<string>(['profile', 'launchArgs']);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const isNumber = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

function validLocale(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 35) return false;
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validStorageState(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value['cookies']) || !Array.isArray(value['origins'])) return false;
  return value['cookies'].every(isObject) && value['origins'].every((o) => isObject(o) && typeof o['origin'] === 'string' && Array.isArray(o['localStorage']));
}

export type SharedContextExtras = {
  /** Egress de la session (tâche 1.5) : `http://127.0.0.1:<port>`. Sans lui, le contexte hérite du proxy de lancement fermé. */
  egressProxyUrl?: string;
};

/** Options de `browser.newContext` pour une session shared ; lève `InvalidSessionOptionError` (tous les champs fautifs). */
export function sharedContextOptions(input: SharedSessionInput, extras: SharedContextExtras = {}): BrowserContextOptions {
  const details: InvalidOptionDetail[] = [];
  const fail = (field: string, reason: string): void => void details.push({ field, reason });
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (raw[key] === undefined) continue;
    if (DEDICATED_ONLY.has(key)) fail(key, 'réservé aux sessions dedicated');
    else if (!KNOWN.has(key)) fail(key, 'champ inconnu pour une session shared');
  }

  const options: BrowserContextOptions = {
    viewport: { ...SHARED_CONTEXT_DEFAULTS.viewport },
    locale: SHARED_CONTEXT_DEFAULTS.locale,
    timezoneId: SHARED_CONTEXT_DEFAULTS.timezoneId,
    colorScheme: SHARED_CONTEXT_DEFAULTS.colorScheme,
    acceptDownloads: SHARED_CONTEXT_DEFAULTS.acceptDownloads,
  };

  if (input.viewport !== undefined) {
    const v = input.viewport as unknown;
    if (isObject(v) && isInt(v['width'], 1, VIEWPORT_MAX.width) && isInt(v['height'], 1, VIEWPORT_MAX.height)) options.viewport = { width: v['width'], height: v['height'] };
    else fail('viewport', `entiers attendus, largeur 1 à ${VIEWPORT_MAX.width}, hauteur 1 à ${VIEWPORT_MAX.height}`);
  }
  if (input.locale !== undefined) {
    if (validLocale(input.locale)) options.locale = input.locale;
    else fail('locale', 'balise de langue BCP 47 attendue');
  }
  if (input.timezoneId !== undefined) {
    if (validTimeZone(input.timezoneId)) options.timezoneId = input.timezoneId;
    else fail('timezoneId', 'fuseau IANA attendu');
  }
  if (input.userAgent !== undefined) {
    const ua = input.userAgent as unknown;
    if (typeof ua === 'string' && ua.length > 0 && ua.length <= USER_AGENT_MAX && !CONTROL.test(ua)) options.userAgent = ua;
    else fail('userAgent', `1 à ${USER_AGENT_MAX} caractères, sans caractère de contrôle`);
  }
  if (input.extraHTTPHeaders !== undefined) {
    const headers = input.extraHTTPHeaders as unknown;
    if (!isObject(headers) || Object.keys(headers).length > HEADERS_MAX) {
      fail('extraHTTPHeaders', `objet de ${HEADERS_MAX} en-têtes au plus attendu`);
    } else {
      const accepted: Record<string, string> = {};
      let ok = true;
      for (const [name, value] of Object.entries(headers)) {
        if (!HEADER_NAME.test(name)) fail('extraHTTPHeaders', `nom d’en-tête invalide « ${name.slice(0, 64)} »`);
        else if (FORBIDDEN_HEADERS.has(name.toLowerCase())) fail('extraHTTPHeaders', `en-tête ${name} réservé au transport`);
        else if (typeof value !== 'string' || value.length > HEADER_VALUE_MAX || CONTROL.test(value.replaceAll('\t', ' '))) fail('extraHTTPHeaders', `valeur de ${name} invalide`);
        else {
          accepted[name] = value;
          continue;
        }
        ok = false;
      }
      if (ok && Object.keys(accepted).length > 0) options.extraHTTPHeaders = accepted;
    }
  }
  if (input.geolocation !== undefined) {
    const g = input.geolocation as unknown;
    if (isObject(g) && isNumber(g['latitude'], -90, 90) && isNumber(g['longitude'], -180, 180) && (g['accuracy'] === undefined || isNumber(g['accuracy'], 0, 1e7))) {
      options.geolocation = { latitude: g['latitude'], longitude: g['longitude'], ...(g['accuracy'] === undefined ? {} : { accuracy: g['accuracy'] as number }) };
      // Seule permission accordée : celle que l'option rend utile.
      options.permissions = ['geolocation'];
    } else fail('geolocation', 'latitude de -90 à 90, longitude de -180 à 180, précision positive');
  }
  if (input.colorScheme !== undefined) {
    if ((COLOR_SCHEMES as readonly unknown[]).includes(input.colorScheme)) options.colorScheme = input.colorScheme;
    else fail('colorScheme', `${COLOR_SCHEMES.join(', ')} attendu`);
  }
  if (input.acceptDownloads !== undefined) {
    if (typeof input.acceptDownloads === 'boolean') options.acceptDownloads = input.acceptDownloads;
    else fail('acceptDownloads', 'booléen attendu');
  }
  if (input.storageState !== undefined) {
    // Jamais une chaîne : Playwright la lirait comme un chemin de fichier sur le nœud.
    if (validStorageState(input.storageState)) options.storageState = input.storageState as BrowserContextOptions['storageState'];
    else fail('storageState', 'objet {cookies, origins} attendu');
  }

  if (extras.egressProxyUrl !== undefined) {
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(extras.egressProxyUrl)) throw new RangeError('egress de session : http://127.0.0.1:<port> attendu');
    options.proxy = { server: extras.egressProxyUrl, bypass: '<-loopback>' };
  }

  if (details.length > 0) throw new InvalidSessionOptionError(details);
  return options;
}
