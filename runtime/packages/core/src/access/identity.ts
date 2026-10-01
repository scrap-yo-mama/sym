// SPDX-License-Identifier: AGPL-3.0-only
// Identité du robot (tâche 1.11, 17 §5) : User-Agent honnête `Scrapyomama/<version> (+<contact>)`, jeton produit,
// version et contact DE L'INSTANCE (celui de l'opérateur, jamais celui de l'éditeur du logiciel). Le contact est saisi à
// l'assistant de premier démarrage (réglage `instance_contact`) ou fourni par `INSTANCE_CONTACT` ; il est requis avant
// la première enquête (`requireInstanceContact`). Aucun masquage : le navigateur du worker garde son User-Agent et y
// ajoute celui-ci (X2).
import { PRODUCT_TOKEN } from './robots.js';

export class InstanceContactError extends Error {
  readonly code: 'instance_contact_missing' | 'instance_contact_invalid';
  constructor(code: InstanceContactError['code'], message: string) {
    super(message);
    this.name = 'InstanceContactError';
    this.code = code;
  }
}

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;
const MAX_CONTACT = 200;

/**
 * Contact d'instance normalisé : URL `https://` ou `http://` sans identifiants ni fragment, `mailto:` ou adresse
 * électronique (rendue en `mailto:`). Lève `InstanceContactError` sinon (rien qui puisse casser l'en-tête).
 */
export function normalizeInstanceContact(raw: string): string {
  const value = raw.trim();
  if (value === '') throw new InstanceContactError('instance_contact_missing', "contact d'instance absent");
  if (value.length > MAX_CONTACT || /[\s()<>"\\]/.test(value) || /[^\x21-\x7e]/.test(value)) {
    throw new InstanceContactError('instance_contact_invalid', "contact d'instance : URL http(s), mailto: ou adresse électronique attendue");
  }
  if (EMAIL.test(value)) return `mailto:${value}`;
  if (/^mailto:/i.test(value)) {
    const address = value.slice('mailto:'.length);
    if (EMAIL.test(address)) return `mailto:${address}`;
    throw new InstanceContactError('instance_contact_invalid', "contact d'instance : adresse mailto: invalide");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InstanceContactError('instance_contact_invalid', "contact d'instance : URL http(s), mailto: ou adresse électronique attendue");
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new InstanceContactError('instance_contact_invalid', "contact d'instance : URL http(s) sans identifiants ni fragment attendue");
  }
  return url.href;
}

/** Contact d'instance : réglage de l'assistant d'abord, puis `INSTANCE_CONTACT`. `null` si aucun n'est posé. */
export function resolveInstanceContact(setting: unknown, env: Readonly<Record<string, string | undefined>> = {}): string | null {
  const fromSetting = typeof setting === 'string' ? setting : typeof setting === 'object' && setting !== null && typeof (setting as { contact?: unknown }).contact === 'string' ? (setting as { contact: string }).contact : undefined;
  for (const candidate of [fromSetting, env['INSTANCE_CONTACT']]) {
    if (candidate === undefined || candidate.trim() === '') continue;
    return normalizeInstanceContact(candidate);
  }
  return null;
}

/** Contact exigé avant toute enquête (17 §5) : lève `instance_contact_missing` sans lui. */
export function requireInstanceContact(contact: string | null | undefined): string {
  if (contact === null || contact === undefined || contact === '') {
    throw new InstanceContactError('instance_contact_missing', "contact d'instance requis avant la première enquête (assistant de premier démarrage ou INSTANCE_CONTACT)");
  }
  return normalizeInstanceContact(contact);
}

const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;

/** User-Agent du robot : `Scrapyomama/<version> (+<contact>)`, ou `Scrapyomama/<version>` tant qu'aucun contact n'est posé. */
export function buildUserAgent(options: { readonly version: string; readonly contact: string | null }): string {
  const version = VERSION.test(options.version) ? options.version : '0.0.0';
  const base = `${PRODUCT_TOKEN}/${version}`;
  return options.contact === null ? base : `${base} (+${normalizeInstanceContact(options.contact)})`;
}

/** User-Agent du navigateur : le sien, tel qu'il est, suivi de celui du robot (aucun masquage, X2). */
export function browserUserAgent(browserDefault: string, robotUserAgent: string): string {
  const own = browserDefault.replace(/[^\x20-\x7e]/g, '').trim();
  return own === '' ? robotUserAgent : `${own} ${robotUserAgent}`;
}
