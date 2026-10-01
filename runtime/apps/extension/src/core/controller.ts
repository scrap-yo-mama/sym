// SPDX-License-Identifier: AGPL-3.0-only
// Noyau de l'extension (07 § 1-2), sans API Chrome directe : les capacités sont injectées (testables avec Vitest).
// - Appairage : URL de l'instance + code → jeton lié à (utilisateur, appareil), gardé dans le stockage local. Un nouvel
//   appairage efface d'abord tout l'état du précédent (consentements, permissions d'hôte) : un consentement ne vaut que
//   pour l'instance qu'il nomme.
// - Consentement par domaine, enregistré AVANT toute lecture de cookie ; aucune lecture sans consentement en usage
//   serveur, destinataire = instance appairée ET permission d'hôte accordée (assert_consent_before_capture). Mode
//   tunnel par défaut : aucun cookie ne quitte le navigateur (assert_no_cookie_in_tunnel_mode).
// - La liste des domaines connectés de l'instance fait foi (07 § 1.4) : un domaine déconnecté ailleurs (console, autre
//   appareil) perd ici son consentement et sa permission d'hôte avant toute nouvelle lecture.
// - Révocation : « Déconnecter ce site » retire ici le consentement et la permission d'hôte, puis efface le domaine sur
//   l'instance ; « Sign out » oublie tout ici, puis révoque le jeton. L'effacement local passe toujours en premier et
//   ne dépend jamais de la réponse de l'instance (injoignable, disparue) : l'échec distant est seulement signalé.
// Seul ce module lit des cookies, et seulement par `#readCookies` (vérifié par un test statique).
import { checkHost, cookieMatchesDomain, originPatterns } from './host-guard.ts';
import { checkInstanceUrl, instancePattern } from './instance.ts';

export type SiteMode = 'tunnel' | 'server';

/** Consentement explicite d'un domaine (07 § 2) : domaine, usage, destinataire des cookies, date du clic. */
export type Consent = {
  domain: string;
  mode: SiteMode;
  /** Origine de l'instance en usage serveur ; `null` en tunnel (les cookies restent dans le navigateur). */
  recipient: string | null;
  grantedAt: string;
};

export type Pairing = { origin: string; token: string; email: string; deviceLabel: string | null; expiresAt: string };

/** Cookie tel que lu par `chrome.cookies.getAll` (champs utiles). */
export type BrowserCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  expirationDate?: number;
  session?: boolean;
};

export type Deps = {
  storage: { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void>; remove(key: string): Promise<void> };
  permissions: { contains(origins: string[]): Promise<boolean>; remove(origins: string[]): Promise<boolean> };
  cookies: { getAll(details: { url: string } | { domain: string }): Promise<BrowserCookie[]> };
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json(): Promise<unknown> }>;
  randomId: () => string;
};

export class ExtensionError extends Error {
  override name = 'ExtensionError';
  constructor(
    readonly code:
      | 'not_paired'
      | 'invalid_instance'
      | 'https_required'
      | 'invalid_pairing_code'
      | 'domain_not_allowed'
      | 'consent_required'
      | 'permission_required'
      | 'site_disconnected'
      | 'unauthorized'
      | 'instance_error',
    message: string,
  ) {
    super(message);
  }
}

const KEYS = { pairing: 'pairing', consents: 'consents', deviceId: 'device_id' } as const;

/** Domaine connecté, tel que l'instance le connaît (`GET /api/extension/session`). */
type RemoteSite = { domain: string; serverUseAllowed: boolean; hasServerCookies: boolean; consentedAt?: string };
type RemoteSession = { email: string; deviceLabel: string | null; sites: RemoteSite[] };

/**
 * Domaine connecté affiché. `onThisBrowser` : consentement donné dans ce navigateur (seul cas où des cookies peuvent
 * être lus ici) ; sinon, domaine connecté ailleurs (autre appareil, appairage précédent), déconnectable d'ici.
 */
export type SiteState = Consent & { serverHasCookies: boolean; onThisBrowser: boolean };
/** `notice` : avertissement d'une révocation faite ici mais pas sur l'instance (posé par le service worker). */
export type Status =
  | { paired: false; notice?: string }
  | { paired: true; email: string; origin: string; deviceLabel: string | null; sites: SiteState[]; instanceError?: string; notice?: string };

const SAME_SITE = new Set(['no_restriction', 'lax', 'strict', 'unspecified']);

export class ExtensionController {
  readonly #deps: Deps;
  /** Lectures de cookies effectuées (observabilité locale, jamais transmise). */
  cookieReads = 0;

  constructor(deps: Deps) {
    this.#deps = deps;
  }

  async #pairing(): Promise<Pairing | null> {
    return ((await this.#deps.storage.get(KEYS.pairing)) as Pairing | undefined) ?? null;
  }

  async #consents(): Promise<Record<string, Consent>> {
    return ((await this.#deps.storage.get(KEYS.consents)) as Record<string, Consent> | undefined) ?? {};
  }

  async #deviceId(): Promise<string> {
    const existing = (await this.#deps.storage.get(KEYS.deviceId)) as string | undefined;
    if (existing) return existing;
    const id = this.#deps.randomId();
    await this.#deps.storage.set(KEYS.deviceId, id);
    return id;
  }

  /** Requête authentifiée par le jeton de `pairing` ; lève si l'instance est injoignable. */
  #send(pairing: Pairing, method: string, path: string, body?: unknown): Promise<{ status: number; json(): Promise<unknown> }> {
    return this.#deps.fetch(`${pairing.origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${pairing.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async #api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const pairing = await this.#pairing();
    if (!pairing) throw new ExtensionError('not_paired', 'This browser is not paired with an instance.');
    const res = await this.#send(pairing, method, path, body);
    if (res.status === 401) {
      // Jeton révoqué (par l'utilisateur ou un admin) ou expiré : l'appairage local est oublié.
      await this.#forget();
      throw new ExtensionError('unauthorized', 'Pairing revoked or expired: pair again.');
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data };
  }

  /**
   * Oublie l'appairage : consentements, permissions d'hôte des domaines ET de l'instance (moindre privilège).
   * `keepPattern` : motif d'hôte de la nouvelle instance, accordé au même clic, qui ne doit pas être retiré.
   */
  async #forget(keepPattern?: string): Promise<void> {
    const pairing = await this.#pairing();
    const consents = await this.#consents();
    for (const domain of Object.keys(consents)) await this.#deps.permissions.remove(originPatterns(domain));
    if (pairing) {
      const pattern = instancePattern(pairing.origin);
      if (pattern !== keepPattern) await this.#deps.permissions.remove([pattern]);
    }
    await this.#deps.storage.remove(KEYS.pairing);
    await this.#deps.storage.remove(KEYS.consents);
  }

  async #dropConsent(domain: string): Promise<void> {
    const consents = await this.#consents();
    delete consents[domain];
    await this.#deps.storage.set(KEYS.consents, consents);
    await this.#deps.permissions.remove(originPatterns(domain));
  }

  /** Domaines connectés selon l'instance ; lève si l'instance est injoignable ou en erreur. */
  async #remoteSession(): Promise<RemoteSession> {
    const { status, data } = await this.#api('GET', '/api/extension/session');
    if (status !== 200) throw new ExtensionError('instance_error', `Instance error (HTTP ${status}).`);
    return data as RemoteSession;
  }

  /**
   * Rapproche les consentements locaux de la liste de l'instance, qui fait foi : un domaine qu'elle ne connaît plus
   * perd son consentement et sa permission d'hôte ; un domaine repassé en tunnel y perd l'usage serveur.
   */
  async #reconcile(remote: readonly RemoteSite[]): Promise<Record<string, Consent>> {
    const consents = await this.#consents();
    const byDomain = new Map(remote.map((s) => [s.domain, s]));
    let changed = false;
    for (const [domain, consent] of Object.entries(consents)) {
      const site = byDomain.get(domain);
      if (!site) {
        delete consents[domain];
        await this.#deps.permissions.remove(originPatterns(domain));
        changed = true;
      } else if (consent.mode === 'server' && !site.serverUseAllowed) {
        consents[domain] = { ...consent, mode: 'tunnel', recipient: null };
        changed = true;
      }
    }
    if (changed) await this.#deps.storage.set(KEYS.consents, consents);
    return consents;
  }

  /**
   * Appairage (07 § 1). La permission d'hôte de l'instance est demandée par le popup, au clic. Un appairage existant
   * est d'abord oublié en entier : aucun consentement donné pour une instance ne vaut pour une autre.
   */
  async pair(input: { instanceUrl: string; code: string; deviceLabel: string | null }): Promise<Pairing> {
    const instance = checkInstanceUrl(input.instanceUrl);
    if (!instance.ok) {
      throw new ExtensionError(instance.reason === 'https_required' ? 'https_required' : 'invalid_instance', 'Instance URL refused: https:// is required.');
    }
    // Pas de révocation du jeton précédent ici : l'ancienne instance peut être injoignable (c'est souvent pourquoi on
    // se ré-appaire) ; l'utilisateur le révoque depuis sa console, et il expire sans usage au bout de 90 jours.
    await this.#forget(instancePattern(instance.origin));
    const res = await this.#deps.fetch(`${instance.origin}/api/extension/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: input.code, deviceId: await this.#deviceId(), ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}) }),
    });
    if (res.status === 400 || res.status === 429) throw new ExtensionError('invalid_pairing_code', 'Unknown, expired or already used pairing code.');
    if (res.status !== 201) throw new ExtensionError('instance_error', `Instance error (HTTP ${res.status}).`);
    const data = (await res.json()) as { token: string; email: string; deviceLabel: string | null; expiresAt: string };
    const pairing: Pairing = { origin: instance.origin, token: data.token, email: data.email, deviceLabel: data.deviceLabel, expiresAt: data.expiresAt };
    await this.#deps.storage.set(KEYS.pairing, pairing);
    return pairing;
  }

  /**
   * État pour le popup. Instance injoignable ou en erreur : l'extension reste appairée (rien n'est oublié) et l'erreur
   * est rendue dans `instanceError` ; seul un jeton refusé (401) ramène à l'écran d'appairage.
   */
  async status(): Promise<Status> {
    const pairing = await this.#pairing();
    if (!pairing) return { paired: false };
    let remote: RemoteSession;
    try {
      remote = await this.#remoteSession();
    } catch (error) {
      if (error instanceof ExtensionError && (error.code === 'unauthorized' || error.code === 'not_paired')) throw error;
      const sites = Object.values(await this.#consents()).map((c) => ({ ...c, serverHasCookies: false, onThisBrowser: true }));
      const reason = error instanceof ExtensionError ? error.message : 'instance unreachable.';
      return { paired: true, email: pairing.email, origin: pairing.origin, deviceLabel: pairing.deviceLabel, sites, instanceError: `Cannot reach your instance: ${reason}` };
    }
    const consents = await this.#reconcile(remote.sites);
    const sites = remote.sites.map((s): SiteState => {
      const local = consents[s.domain];
      if (local) return { ...local, serverHasCookies: s.hasServerCookies, onThisBrowser: true };
      return {
        domain: s.domain,
        mode: s.serverUseAllowed ? 'server' : 'tunnel',
        recipient: s.serverUseAllowed ? pairing.origin : null,
        grantedAt: s.consentedAt ?? '',
        serverHasCookies: s.hasServerCookies,
        onThisBrowser: false,
      };
    });
    return { paired: true, email: remote.email, origin: pairing.origin, deviceLabel: remote.deviceLabel, sites };
  }

  /**
   * « Connecter ce site », après le clic de consentement (07 § 2). Le consentement est enregistré d'abord ; en usage
   * serveur, les cookies sont ensuite lus et envoyés. La permission d'hôte a été demandée par le popup au même clic.
   */
  async connectSite(input: { domain: string; mode: SiteMode; now: string }): Promise<SiteState> {
    const verdict = checkHost(input.domain);
    if (!verdict.ok) throw new ExtensionError('domain_not_allowed', 'This site cannot be connected (private address, internal or invalid name).');
    const domain = verdict.domain;
    if (!(await this.#deps.permissions.contains(originPatterns(domain)))) {
      throw new ExtensionError('permission_required', 'Access to this site was not granted.');
    }
    const pairing = await this.#pairing();
    if (!pairing) throw new ExtensionError('not_paired', 'This browser is not paired with an instance.');
    const { status } = await this.#api('PUT', `/api/extension/sites/${encodeURIComponent(domain)}`, { serverUseAllowed: input.mode === 'server' });
    if (status !== 200 && status !== 201) throw new ExtensionError(status === 400 ? 'domain_not_allowed' : 'instance_error', `Instance error (HTTP ${status}).`);
    const consent: Consent = { domain, mode: input.mode, recipient: input.mode === 'server' ? pairing.origin : null, grantedAt: input.now };
    await this.#deps.storage.set(KEYS.consents, { ...(await this.#consents()), [domain]: consent });
    let serverHasCookies = false;
    if (input.mode === 'server') serverHasCookies = await this.capture(domain);
    return { ...consent, serverHasCookies, onThisBrowser: true };
  }

  /**
   * Lit et envoie les cookies d'un domaine en usage serveur. Refus, sans aucune lecture, si le consentement manque,
   * s'il est en mode tunnel, s'il nomme un autre destinataire que l'instance appairée, ou si la permission d'hôte
   * n'est pas accordée. Renvoie vrai si des cookies sont partis.
   */
  async capture(domain: string): Promise<boolean> {
    const pairing = await this.#pairing();
    if (!pairing) throw new ExtensionError('not_paired', 'This browser is not paired with an instance.');
    const consent = (await this.#consents())[domain];
    if (!consent) throw new ExtensionError('consent_required', `No consent recorded for ${domain}.`);
    if (consent.mode !== 'server') throw new ExtensionError('consent_required', `${domain} is in tunnel mode: its cookies stay in this browser.`);
    if (consent.recipient !== pairing.origin) {
      throw new ExtensionError('consent_required', `Consent for ${domain} names another recipient than the paired instance: connect the site again.`);
    }
    if (!(await this.#deps.permissions.contains(originPatterns(domain)))) throw new ExtensionError('permission_required', `Access to ${domain} is not granted.`);
    const cookies = await this.#readCookies(domain);
    const { status } = await this.#api('PUT', `/api/extension/sites/${encodeURIComponent(domain)}/cookies`, { cookies });
    if (status === 404) {
      // Domaine déconnecté sur l'instance entre-temps : plus aucune lecture ici.
      await this.#dropConsent(domain);
      throw new ExtensionError('site_disconnected', `${domain} is no longer connected on your instance.`);
    }
    if (status !== 204) throw new ExtensionError('instance_error', `Instance error (HTTP ${status}).`);
    return cookies.length > 0;
  }

  /**
   * Seul point de lecture des cookies (appelé par `capture`, après ses contrôles). `getAll({ url })` rend les cookies
   * de l'hôte et de ses domaines parents au chemin « / » ; `getAll({ domain })` ceux de l'hôte à tous les chemins
   * (et de ses sous-domaines, écartés) : l'union, filtrée par la règle de l'instance (`cookieMatchesDomain`), est la
   * session complète du domaine.
   */
  async #readCookies(domain: string): Promise<BrowserCookie[]> {
    this.cookieReads += 1;
    const seen = new Map<string, BrowserCookie>();
    for (const details of [{ url: `https://${domain}/` }, { url: `http://${domain}/` }, { domain }]) {
      for (const c of await this.#deps.cookies.getAll(details)) {
        if (cookieMatchesDomain(c.domain, domain)) seen.set(`${c.domain}|${c.path}|${c.name}`, c);
      }
    }
    return [...seen.values()].map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      ...(c.sameSite && SAME_SITE.has(c.sameSite) ? { sameSite: c.sameSite } : {}),
      ...(c.expirationDate !== undefined ? { expirationDate: c.expirationDate } : {}),
    }));
  }

  /**
   * Resynchronisation (ouverture de Chrome, puis au plus une fois par heure) des domaines en usage serveur. La liste
   * de l'instance est relue d'abord : un domaine déconnecté ailleurs n'est plus lu. Instance injoignable : rien n'est lu.
   */
  async resyncAll(): Promise<number> {
    if (!(await this.#pairing())) return 0;
    let consents: Record<string, Consent>;
    try {
      consents = await this.#reconcile((await this.#remoteSession()).sites);
    } catch {
      return 0;
    }
    let done = 0;
    for (const consent of Object.values(consents)) {
      if (consent.mode !== 'server') continue;
      try {
        await this.capture(consent.domain);
        done += 1;
      } catch (error) {
        if (error instanceof ExtensionError && error.code === 'unauthorized') return done;
      }
    }
    return done;
  }

  /**
   * « Déconnecter ce site » : consentement et permission d'hôte retirés ICI d'abord, puis domaine et cookies effacés
   * sur l'instance. Le clic est honoré même instance injoignable ou en erreur : plus aucune lecture n'a lieu dans ce
   * navigateur, et l'échec distant est signalé (le domaine reste alors listé « connecté ailleurs », déconnectable d'ici
   * ou depuis la console au retour de l'instance).
   */
  async disconnectSite(domain: string): Promise<Revocation> {
    await this.#dropConsent(domain);
    let status: number;
    try {
      ({ status } = await this.#api('DELETE', `/api/extension/sites/${encodeURIComponent(domain)}`));
    } catch (error) {
      return { remoteRevoked: false, warning: disconnectWarning(domain, failureReason(error)) };
    }
    if (status === 204 || status === 400) return { remoteRevoked: true };
    return { remoteRevoked: false, warning: disconnectWarning(domain, `HTTP ${status}`) };
  }

  /**
   * Déconnexion de l'instance : tout est oublié ICI d'abord (appairage, consentements, permissions d'hôte des domaines
   * et de l'instance), puis le jeton de cet appareil est révoqué sur l'instance. Instance injoignable ou disparue : la
   * déconnexion locale tient quand même (sinon l'extension resterait sans issue) et l'échec distant est signalé ; le
   * jeton se révoque alors depuis la console et expire sans usage au bout de 90 jours.
   */
  async unpair(): Promise<Revocation> {
    const pairing = await this.#pairing();
    await this.#forget();
    if (!pairing) return { remoteRevoked: true };
    let status: number;
    try {
      ({ status } = await this.#send(pairing, 'DELETE', '/api/extension/session'));
    } catch (error) {
      return { remoteRevoked: false, warning: unpairWarning(failureReason(error)) };
    }
    // 401 : jeton déjà révoqué ou expiré sur l'instance.
    if (status === 204 || status === 401) return { remoteRevoked: true };
    return { remoteRevoked: false, warning: unpairWarning(`HTTP ${status}`) };
  }
}

/** Résultat d'une révocation : l'effacement local a toujours eu lieu ; `warning` dit ce qui n'a pas pu l'être ailleurs. */
export type Revocation = { remoteRevoked: true } | { remoteRevoked: false; warning: string };

function failureReason(error: unknown): string {
  return error instanceof ExtensionError ? error.message : 'network error';
}

const unpairWarning = (reason: string) =>
  `Signed out in this browser, but your instance could not be reached to revoke this device (${reason}). Revoke it from Settings › Extension on your instance.`;

const disconnectWarning = (domain: string, reason: string) =>
  `${domain} is disconnected in this browser, but your instance could not be reached to delete it and its cookies (${reason}). Disconnect it again once the instance is back.`;
