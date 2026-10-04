// SPDX-License-Identifier: AGPL-3.0-only
// Identité du robot (tâche 1.11, 17 §5, décision du 2026-10-01) : par défaut, le User-Agent RÉEL du moteur embarqué (la
// chaîne standard de la version et de la plateforme réelles de Chromium, sans le marqueur `HeadlessChrome`), identique
// d'un run à l'autre pour une même image, aucune rotation, aucune falsification d'empreinte (X2). Une seule fonction
// la construit (`buildUserAgent`) pour le client HTTP (E1) et pour TOUT contexte Chromium. L'identification de
// l'instance est OPTIONNELLE (réglage `identify_instance`, désactivé par défaut) : activée, elle ajoute le jeton
// `compatible; Scrapyomama/<version>; +<contact>` au User-Agent et, si le contact est une adresse électronique,
// l'en-tête `From` (RFC 9110 §10.1.2). Version et contact sont ceux DE L'INSTANCE (celui de l'opérateur, jamais celui
// de l'éditeur du logiciel) : saisi à l'assistant de premier démarrage (réglage `instance_contact`) ou fourni par
// `INSTANCE_CONTACT`, requis avant la première enquête (`requireInstanceContact`).
/** Jeton produit du User-Agent quand l'identification de l'instance est activée (17 §5). */
export const PRODUCT_TOKEN = 'Scrapyomama';

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


/**
 * `Accept-Language` d'un Chromium vierge de l'image (21 § 6, 17 § 5) : la valeur RÉELLE du moteur, jamais celle d'un utilisateur,
 * d'un compte, d'un run ni d'un pays de proxy. Mesurée sur le moteur (image Linux `LANG=C.UTF-8`, CI ubuntu, macOS, Chromium 153) :
 * un Chromium vierge n'envoie AUCUN en-tête `Accept-Language`, d'où `null`. Le client HTTP (E1) fait de même (il retire
 * l'en-tête qu'une stratégie poserait) ; les contextes Chromium n'ont ni option `locale`, ni `--lang`, ni commande CDP de langue
 * ou de fuseau. Contrôlée sur toute plateforme par `assert_accept_language_engine_real`
 * (tests/browser/engine-accept-language.security.test.ts), comme le User-Agent : si le moteur change, ce test le signale.
 */
export const ENGINE_ACCEPT_LANGUAGE: string | null = null;

const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const ENGINE_VERSION = /^(\d{1,4})\.\d{1,6}(?:\.\d{1,6}){0,2}$/;

/** Moteur embarqué : version lue sur `browser.version()` (ou la version épinglée de Chromium) et plateforme réelle (`process.platform`). */
export type EngineIdentity = { readonly version: string; readonly platform: string };

export class EngineUserAgentError extends Error {
  override name = 'EngineUserAgentError';
}

/** Jeton de plateforme que Chromium annonce lui-même (chaîne unifiée de sa version, quelle que soit l'architecture). */
function platformToken(platform: string): string {
  switch (platform) {
    case 'darwin':
      return 'Macintosh; Intel Mac OS X 10_15_7';
    case 'win32':
      return 'Windows NT 10.0; Win64; x64';
    case 'linux':
      return 'X11; Linux x86_64';
    default:
      throw new EngineUserAgentError(`plateforme du moteur non prise en charge : ${platform}`);
  }
}

/**
 * User-Agent standard de Chromium pour sa version et sa plateforme réelles, SANS le marqueur `HeadlessChrome` :
 * `Mozilla/5.0 (<plateforme>) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<majeure>.0.0.0 Safari/537.36`. Jamais une
 * autre version ni un autre navigateur ; la valeur ne dépend que du moteur (aucun aléa, aucune rotation).
 */
export function engineUserAgent(engine: EngineIdentity): string {
  const major = ENGINE_VERSION.exec(engine.version.trim())?.[1];
  if (major === undefined) throw new EngineUserAgentError(`version du moteur illisible : ${engine.version}`);
  return `Mozilla/5.0 (${platformToken(engine.platform)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Number(major)}.0.0.0 Safari/537.36`;
}

/**
 * LA fonction qui construit le User-Agent du robot, pour le client HTTP (E1) comme pour tout
 * contexte Chromium. Sans `identify` (réglage `identify_instance` désactivé, le défaut) : la chaîne du moteur, telle
 * quelle. Avec `identify` : la même suivie du jeton produit (format de Googlebot), avec le contact de l'instance s'il
 * est posé : `... Safari/537.36 (compatible; Scrapyomama/<version>; +<contact>)`.
 */
export function buildUserAgent(options: {
  readonly engine: EngineIdentity;
  readonly identify?: { readonly version: string; readonly contact: string | null } | undefined;
}): string {
  const base = engineUserAgent(options.engine);
  const identify = options.identify;
  if (identify === undefined) return base;
  const version = VERSION.test(identify.version) ? identify.version : '0.0.0';
  const contact = identify.contact === null ? '' : `; +${normalizeInstanceContact(identify.contact)}`;
  return `${base} (compatible; ${PRODUCT_TOKEN}/${version}${contact})`;
}

/**
 * En-tête `From` (RFC 9110 §10.1.2 : une adresse électronique) quand l'identification est activée et que le contact en
 * est une ; `null` sinon (un contact URL ne tient que dans le jeton du User-Agent).
 */
export function robotFrom(contact: string | null): string | null {
  if (contact === null) return null;
  const normalized = normalizeInstanceContact(contact);
  return normalized.startsWith('mailto:') ? normalized.slice('mailto:'.length) : null;
}

/**
 * Réglage `identify_instance` : l'identification de l'instance est désactivée par défaut. Réglage admin d'abord
 * (booléen, ou `{ enabled }`), puis `IDENTIFY_INSTANCE` (`true` / `false`). Toute autre valeur : désactivée.
 */
export function resolveIdentifyInstance(setting: unknown, env: Readonly<Record<string, string | undefined>> = {}): boolean {
  return readIdentifyFlag(setting) ?? readIdentifyFlag(env['IDENTIFY_INSTANCE']) ?? false;
}

/** Interrupteur lu dans un réglage ou une variable : booléen, `true` / `false` (casse et espaces ignorés), ou `{ enabled }`. */
function readIdentifyFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
    return undefined;
  }
  if (typeof value === 'object' && value !== null && 'enabled' in value) return readIdentifyFlag((value as { enabled?: unknown }).enabled);
  return undefined;
}

/**
 * Replis que le worker lit dans SON environnement (`IDENTIFY_INSTANCE`, `INSTANCE_CONTACT`), publiés avec le moteur pour que
 * la console affiche ce qui part réellement quand aucun réglage n'est posé (tâche 3.8b) : le serveur ne voit pas
 * l'environnement du worker. `null` : variable absente ou illisible (le worker l'ignore alors aussi).
 */
export function identityFromEnv(env: Readonly<Record<string, string | undefined>>): { identifyInstance: boolean | null; instanceContact: string | null } {
  let instanceContact: string | null;
  try {
    instanceContact = resolveInstanceContact(undefined, env);
  } catch {
    instanceContact = null;
  }
  return { identifyInstance: readIdentifyFlag(env['IDENTIFY_INSTANCE']) ?? null, instanceContact };
}

/**
 * `INSTANCE_CONTACT` posé mais illisible (UX-05) : `identityFromEnv` le ramène à `null` comme un contact absent, mais le worker,
 * lui, refusera l'enquête pour contact invalide. Publié à part pour que le serveur dise « corrige le contact », pas « renseigne-le ».
 */
export function instanceContactEnvInvalid(env: Readonly<Record<string, string | undefined>>): boolean {
  try {
    resolveInstanceContact(undefined, env);
    return false;
  } catch {
    return true;
  }
}
