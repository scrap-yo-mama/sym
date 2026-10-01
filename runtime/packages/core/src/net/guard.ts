// SPDX-License-Identifier: AGPL-3.0-only
// Garde SSRF (08b §1, INV10) : politique, résolution unique A + AAAA, décision sur les adresses résolues.
// Activée par défaut, non désactivable par un membre. Seules dérogations : ALLOWED_PRIVATE_HOSTS (admin).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { CidrSet, classifyAddress, HARD_BLOCK_REASONS, stripAddress, type BlockReason } from './ip.js';

export type ResolvedAddress = { address: string; family: 4 | 6 };
/** Résolveur injectable (tests de rebinding) ; par défaut getaddrinfo, qui respecte /etc/hosts. */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export type SsrfDenyReason =
  | BlockReason
  | 'blocked_hostname'
  | 'scheme'
  | 'port'
  | 'credentials'
  | 'https_downgrade'
  | 'too_many_redirects'
  | 'unresolvable';

/** Détail réservé au journal admin. Le membre ne voit que `ssrf_blocked` (message et code). */
export type SsrfDenyDetail = { reason: SsrfDenyReason; host: string; port?: number; address?: string };

export class SsrfBlockedError extends Error {
  readonly code = 'ssrf_blocked';
  readonly detail: SsrfDenyDetail;
  constructor(detail: SsrfDenyDetail) {
    super('ssrf_blocked');
    this.name = 'SsrfBlockedError';
    this.detail = detail;
  }
}

export function isSsrfBlocked(error: unknown): boolean {
  return findSsrfBlocked(error) !== undefined;
}

/** Retrouve l'erreur de garde dans une chaîne de `cause` (fetch d'undici enveloppe l'erreur du connecteur). */
export function findSsrfBlocked(error: unknown): SsrfBlockedError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof SsrfBlockedError) return current;
    current = current.cause;
  }
  return undefined;
}

export type SsrfPolicy = {
  /** Noms exacts (minuscules, sans point final) autorisés à résoudre vers une adresse privée. */
  readonly allowedPrivateNames: ReadonlySet<string>;
  /** Plages autorisées même si privées. */
  readonly allowedPrivateCidrs: CidrSet;
  /** Ports autorisés (80 et 443 par défaut, réglables par l'admin). */
  readonly allowedPorts: ReadonlySet<number>;
  /**
   * Drapeau de test « autoriser le privé » (15 §7) : faux par défaut, lu seulement sous NODE_ENV=test,
   * refusé au démarrage ailleurs (donc inopérant dans l'image de production, NODE_ENV=production).
   * Ne lève jamais les classes dures (métadonnées cloud, 0.0.0.0, multicast).
   */
  readonly testAllowPrivate: boolean;
};

export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

/** Noms refusés avant toute résolution (RFC 6761, métadonnées GCP). */
const BLOCKED_NAMES = new Set(['localhost', 'metadata.google.internal', 'metadata.goog']);
const HARD_BLOCKED_NAMES = new Set(['metadata.google.internal', 'metadata.goog']);

export function normalizeHostname(raw: string): string {
  return stripAddress(raw).toLowerCase().replace(/\.+$/, '');
}

function nameBlocked(host: string): boolean {
  return BLOCKED_NAMES.has(host) || host.endsWith('.localhost');
}

export type SsrfPolicyInput = {
  allowedPrivateHosts?: readonly string[];
  allowedPorts?: readonly number[];
  testAllowPrivate?: boolean;
};

export function createSsrfPolicy(input: SsrfPolicyInput = {}): SsrfPolicy {
  const names = new Set<string>();
  const cidrs = new CidrSet();
  for (const raw of input.allowedPrivateHosts ?? []) {
    const entry = raw.trim();
    if (entry === '') continue;
    const bare = entry.split('/')[0] ?? '';
    if (entry.includes('/') || isIP(stripAddress(bare)) !== 0) {
      const prefix = entry.split('/')[1];
      const minimum = isIP(stripAddress(bare)) === 6 ? 16 : 8;
      if (prefix !== undefined && Number(prefix) < minimum) {
        throw new TypeError(`ALLOWED_PRIVATE_HOSTS : « ${entry} » trop large (préfixe /${minimum} au minimum)`);
      }
      cidrs.add(entry);
    }
    else if (/^[a-z0-9.-]+$/i.test(entry) && !entry.includes('*')) names.add(normalizeHostname(entry));
    else throw new TypeError(`ALLOWED_PRIVATE_HOSTS : entrée invalide « ${entry} » (nom exact ou CIDR)`);
  }
  const ports = new Set(input.allowedPorts ?? DEFAULT_ALLOWED_PORTS);
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError(`port invalide : ${port}`);
  }
  return {
    allowedPrivateNames: names,
    allowedPrivateCidrs: cidrs,
    allowedPorts: ports,
    testAllowPrivate: input.testAllowPrivate === true,
  };
}

export const TEST_ALLOW_PRIVATE_ENV = 'RUNTIME_TEST_ALLOW_PRIVATE';

/**
 * Politique depuis l'environnement. `ALLOWED_PRIVATE_HOSTS` : noms exacts ou CIDR séparés par des virgules,
 * vide par défaut. `ALLOWED_EGRESS_PORTS` : liste de ports (nom de variable à valider avec le schéma de config).
 * Le drapeau de test n'est accepté que sous NODE_ENV=test ; sa seule présence ailleurs fait échouer le démarrage.
 */
export function ssrfPolicyFromEnv(env: Readonly<Record<string, string | undefined>>): SsrfPolicy {
  const flag = env[TEST_ALLOW_PRIVATE_ENV];
  if (flag !== undefined && env.NODE_ENV !== 'test') {
    throw new Error(`${TEST_ALLOW_PRIVATE_ENV} est réservé aux tests (NODE_ENV=test) : refusé au démarrage`);
  }
  const list = (value: string | undefined) =>
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  const ports = list(env.ALLOWED_EGRESS_PORTS);
  return createSsrfPolicy({
    allowedPrivateHosts: list(env.ALLOWED_PRIVATE_HOSTS),
    allowedPorts: ports.length > 0 ? ports.map(Number) : undefined,
    testAllowPrivate: flag === '1' || flag === 'true',
  });
}

export const defaultResolver: Resolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, order: 'verbatim' });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

export type SsrfGuardOptions = { policy?: SsrfPolicy; resolver?: Resolver };

export type TargetCheck = { scheme: 'http:' | 'https:'; host: string; port: number };

export class SsrfGuard {
  readonly policy: SsrfPolicy;
  readonly #resolver: Resolver;

  constructor(options: SsrfGuardOptions = {}) {
    this.policy = options.policy ?? createSsrfPolicy();
    this.#resolver = options.resolver ?? defaultResolver;
  }

  /** Contrôles statiques d'une URL (schéma, identifiants, port, nom), sans résolution. */
  checkUrlStatic(input: string | URL): TargetCheck {
    const url = typeof input === 'string' ? new URL(input) : input;
    const host = normalizeHostname(url.hostname);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new SsrfBlockedError({ reason: 'scheme', host });
    if (url.username !== '' || url.password !== '') throw new SsrfBlockedError({ reason: 'credentials', host });
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
    this.checkPort(host, port);
    return { scheme: url.protocol, host, port };
  }

  checkPort(host: string, port: number): void {
    if (this.policy.allowedPorts.has(port) || this.policy.testAllowPrivate) return;
    throw new SsrfBlockedError({ reason: 'port', host, port });
  }

  /** Décision sur une adresse résolue pour un nom donné. */
  checkAddress(hostname: string, address: string, port?: number): void {
    const host = normalizeHostname(hostname);
    const verdict = classifyAddress(address);
    if (verdict.allowed) return;
    const hard = HARD_BLOCK_REASONS.has(verdict.reason);
    const excepted =
      this.policy.testAllowPrivate ||
      this.policy.allowedPrivateNames.has(host) ||
      this.policy.allowedPrivateCidrs.has(verdict.address);
    if (!hard && excepted) return;
    throw new SsrfBlockedError({ reason: verdict.reason, host, address: verdict.address, port });
  }

  /**
   * Résolution unique (A et AAAA) puis contrôle de chaque adresse : un seul enregistrement interdit suffit à refuser.
   * Renvoie l'adresse à épingler : le socket s'ouvre sur elle, jamais sur une nouvelle résolution.
   */
  async resolve(hostname: string, port: number): Promise<ResolvedAddress> {
    this.checkPort(normalizeHostname(hostname), port);
    return this.resolveAnyPort(hostname, port);
  }

  /**
   * Comme `resolve`, sans la liste de ports : pour une destination que l'admin a configurée lui-même (relais SMTP, 587 ou
   * 465), pas pour une cible saisie par un membre. Noms, adresses résolues et exceptions `ALLOWED_PRIVATE_HOSTS` restent
   * contrôlés à l'identique (métadonnées cloud refusées sans exception).
   */
  async resolveAnyPort(hostname: string, port: number): Promise<ResolvedAddress> {
    const host = normalizeHostname(hostname);
    const allowedByName = this.policy.allowedPrivateNames.has(host) || this.policy.testAllowPrivate;
    if (HARD_BLOCKED_NAMES.has(host) || (nameBlocked(host) && !allowedByName)) {
      throw new SsrfBlockedError({ reason: 'blocked_hostname', host, port });
    }
    const family = isIP(host);
    let records: readonly ResolvedAddress[];
    if (family !== 0) {
      records = [{ address: host, family: family === 6 ? 6 : 4 }];
    } else {
      try {
        records = await this.#resolver(host);
      } catch {
        throw new SsrfBlockedError({ reason: 'unresolvable', host, port });
      }
    }
    if (records.length === 0) throw new SsrfBlockedError({ reason: 'unresolvable', host, port });
    for (const record of records) this.checkAddress(host, record.address, port);
    const first = records[0] as ResolvedAddress;
    return { address: stripAddress(first.address), family: first.family };
  }

  /**
   * Validation complète d'une URL (statique + résolution). Ne suffit jamais seule : la connexion est recontrôlée
   * (connecteur undici, proxy d'egress). Sert au refus précoce, p. ex. à l'enregistrement d'un webhook.
   */
  async checkUrl(input: string | URL): Promise<ResolvedAddress> {
    const target = this.checkUrlStatic(input);
    return this.resolve(target.host, target.port);
  }
}
