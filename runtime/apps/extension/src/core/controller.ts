// SPDX-License-Identifier: AGPL-3.0-only
// Noyau de l'extension (07 § 1-2), sans API Chrome directe : les capacités sont injectées (testables avec Vitest).
// - Appairage : URL de l'instance + code → jeton lié à (utilisateur, appareil), gardé dans le stockage local.
// - Consentement par domaine, enregistré AVANT toute lecture de cookie ; aucune lecture sans consentement en usage
//   serveur ET permission d'hôte accordée (assert_consent_before_capture). Mode tunnel par défaut : aucun cookie ne
//   quitte le navigateur (assert_no_cookie_in_tunnel_mode).
// - Révocation : « Déconnecter ce site » efface le domaine sur l'instance, le consentement et la permission d'hôte.
// Seul ce module lit des cookies, et seulement par `#readCookies` (vérifié par un test statique).
import { checkHost, originPatterns } from './host-guard.ts';
import { checkInstanceUrl } from './instance.ts';

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
  cookies: { getAll(details: { url: string }): Promise<BrowserCookie[]> };
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
      | 'unauthorized'
      | 'instance_error',
    message: string,
  ) {
    super(message);
  }
}

const KEYS = { pairing: 'pairing', consents: 'consents', deviceId: 'device_id' } as const;

export type SiteState = Consent & { serverHasCookies: boolean };
export type Status = { paired: false } | { paired: true; email: string; origin: string; deviceLabel: string | null; sites: SiteState[] };

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

  async #api(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    const pairing = await this.#pairing();
    if (!pairing) throw new ExtensionError('not_paired', 'This browser is not paired with an instance.');
    const res = await this.#deps.fetch(`${pairing.origin}${path}`, {
      method,
      headers: { authorization: `Bearer ${pairing.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 401) {
      // Jeton révoqué (par l'utilisateur ou un admin) ou expiré : l'appairage local est oublié.
      await this.#forget();
      throw new ExtensionError('unauthorized', 'Pairing revoked or expired: pair again.');
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { status: res.status, data };
  }

  async #forget(): Promise<void> {
    const consents = await this.#consents();
    for (const domain of Object.keys(consents)) await this.#deps.permissions.remove(originPatterns(domain));
    await this.#deps.storage.remove(KEYS.pairing);
    await this.#deps.storage.remove(KEYS.consents);
  }

  /** Appairage (07 § 1). La permission d'hôte de l'instance est demandée par le popup, au clic. */
  async pair(input: { instanceUrl: string; code: string; deviceLabel: string | null }): Promise<Pairing> {
    const instance = checkInstanceUrl(input.instanceUrl);
    if (!instance.ok) {
      throw new ExtensionError(instance.reason === 'https_required' ? 'https_required' : 'invalid_instance', 'Instance URL refused: https:// is required.');
    }
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

  async status(): Promise<Status> {
    const pairing = await this.#pairing();
    if (!pairing) return { paired: false };
    const { status, data } = await this.#api('GET', '/api/extension/session');
    if (status !== 200) throw new ExtensionError('instance_error', `Instance error (HTTP ${status}).`);
    const remote = data as { email: string; deviceLabel: string | null; sites: { domain: string; serverUseAllowed: boolean; hasServerCookies: boolean }[] };
    const consents = await this.#consents();
    const sites = Object.values(consents).map((c) => ({ ...c, serverHasCookies: remote.sites.find((s) => s.domain === c.domain)?.hasServerCookies ?? false }));
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
    return { ...consent, serverHasCookies };
  }

  /**
   * Lit et envoie les cookies d'un domaine en usage serveur. Refus, sans aucune lecture, si le consentement manque,
   * s'il est en mode tunnel, ou si la permission d'hôte n'est pas accordée. Renvoie vrai si des cookies sont partis.
   */
  async capture(domain: string): Promise<boolean> {
    const consent = (await this.#consents())[domain];
    if (!consent) throw new ExtensionError('consent_required', `No consent recorded for ${domain}.`);
    if (consent.mode !== 'server') throw new ExtensionError('consent_required', `${domain} is in tunnel mode: its cookies stay in this browser.`);
    if (!(await this.#deps.permissions.contains(originPatterns(domain)))) throw new ExtensionError('permission_required', `Access to ${domain} is not granted.`);
    const cookies = await this.#readCookies(domain);
    const { status } = await this.#api('PUT', `/api/extension/sites/${encodeURIComponent(domain)}/cookies`, { cookies });
    if (status !== 204) throw new ExtensionError('instance_error', `Instance error (HTTP ${status}).`);
    return cookies.length > 0;
  }

  /** Seul point de lecture des cookies (appelé par `capture`, après ses contrôles). */
  async #readCookies(domain: string): Promise<BrowserCookie[]> {
    this.cookieReads += 1;
    const seen = new Map<string, BrowserCookie>();
    for (const url of [`https://${domain}/`, `http://${domain}/`]) {
      for (const c of await this.#deps.cookies.getAll({ url })) seen.set(`${c.domain}|${c.path}|${c.name}`, c);
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

  /** Resynchronisation (ouverture de Chrome, puis au plus une fois par heure) des domaines en usage serveur. */
  async resyncAll(): Promise<number> {
    if (!(await this.#pairing())) return 0;
    let done = 0;
    for (const consent of Object.values(await this.#consents())) {
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

  /** « Déconnecter ce site » : domaine et cookies effacés sur l'instance, consentement et permission retirés ici. */
  async disconnectSite(domain: string): Promise<void> {
    const { status } = await this.#api('DELETE', `/api/extension/sites/${encodeURIComponent(domain)}`);
    if (status !== 204 && status !== 400) throw new ExtensionError('instance_error', `Instance error (HTTP ${status}).`);
    const consents = await this.#consents();
    delete consents[domain];
    await this.#deps.storage.set(KEYS.consents, consents);
    await this.#deps.permissions.remove(originPatterns(domain));
  }

  /** Déconnexion de l'instance : le jeton de cet appareil est révoqué, tout est oublié localement. */
  async unpair(): Promise<void> {
    try {
      await this.#api('DELETE', '/api/extension/session');
    } catch (error) {
      if (!(error instanceof ExtensionError && error.code === 'unauthorized')) throw error;
    }
    await this.#forget();
  }
}
