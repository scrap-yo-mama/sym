// SPDX-License-Identifier: AGPL-3.0-only
// Garde réseau de SYM Browser (cdc/sym-browser 04c § 1.2), écrite pour l'egress (tâche 1.5) et partagée depuis le noyau
// avec les webhooks de la passerelle (tâche 2.5) : contrôle du nom, résolution unique (A et AAAA), décision sur chaque adresse
// résolue, adresse épinglée. Réimplémente dans le module la garde SSRF de SYM (`runtime/packages/core/src/net/guard.ts`, lue
// sans être importée) avec les dérogations de SYM Browser : `SYMB_PRIVATE_HOSTS` (noms exacts ou CIDR, admin du nœud) et le
// drapeau `SYMB_TEST_ALLOW_PRIVATE` (fixtures, lu sous NODE_ENV=test par la configuration, tâche 0.4). Les classes dures
// (métadonnées cloud, 0.0.0.0, multicast, diffusion) sont refusées sans exception.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BrowserConfig } from '../config/load.js';
import { CidrSet, classifyAddress, stripAddress, type BlockReason } from './ip.js';

/**
 * Motifs de refus de l'egress : copie exacte de `EGRESS_BLOCK_REASONS` du contrat `@sym/contracts/browser` (le noyau n'en
 * dépend pas ; l'égalité est vérifiée par un test du nœud). Partagée par l'egress du nœud et les webhooks de la passerelle.
 */
export const EGRESS_DENY_REASONS = ['domain_not_allowed', 'port_not_allowed', 'address_not_public', 'unresolvable', 'egress_closed', 'budget_exceeded'] as const;
export type EgressBlockReason = (typeof EGRESS_DENY_REASONS)[number];

export type ResolvedAddress = { address: string; family: 4 | 6 };
/** Résolveur injectable (tests, rebinding) ; par défaut getaddrinfo, qui respecte /etc/hosts. */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

/** Détail d'un refus (journal du nœud) ; le navigateur ne voit que `reason`. */
export type DenyDetail = BlockReason | 'reserved_name';

/** Refus de l'egress : `reason` est le motif public (403 au navigateur, événement `egress.blocked`). */
export class EgressDeniedError extends Error {
  override name = 'EgressDeniedError';
  readonly reason: EgressBlockReason;
  readonly host: string;
  readonly port: number | undefined;
  readonly address: string | undefined;
  readonly detail: DenyDetail | undefined;
  constructor(reason: EgressBlockReason, host: string, extra: { port?: number; address?: string; detail?: DenyDetail } = {}) {
    super(reason);
    this.reason = reason;
    this.host = host;
    this.port = extra.port;
    this.address = extra.address;
    this.detail = extra.detail;
  }
}

/** Noms refusés avant toute résolution (RFC 6761, métadonnées GCP). Les seconds le sont même pour un nom dérogé. */
const RESERVED_NAMES = new Set(['localhost']);
const HARD_RESERVED_NAMES = new Set(['metadata.google.internal', 'metadata.goog']);

/** Nom normalisé : minuscules, crochets IPv6 et zone retirés, point final retiré. */
export function normalizeHostname(raw: string): string {
  return stripAddress(raw).toLowerCase().replace(/\.+$/, '');
}

export type EgressGuardOptions = {
  /** `SYMB_PRIVATE_HOSTS` : noms exacts ou CIDR joignables bien que non publics (vide par défaut). */
  privateHosts?: readonly string[];
  /** `SYMB_TEST_ALLOW_PRIVATE` (NODE_ENV=test seulement, imposé par la configuration). */
  testAllowPrivate?: boolean;
  resolver?: Resolver;
};

export type EgressGuard = {
  /** Contrôle du nom seul (noms réservés), sans résolution : chemin `dnsViaProxy` (le nom part à l'amont). */
  checkName(host: string, port?: number): void;
  /** Résolution unique puis contrôle de chaque adresse ; rend l'adresse à épingler. */
  resolve(host: string, port: number): Promise<ResolvedAddress>;
  /** Décision sur une adresse (résolue, ou adresse distante effective d'un socket). */
  checkAddress(host: string, address: string, port?: number): void;
};

export const defaultResolver: Resolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, order: 'verbatim' });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

function parsePrivateHosts(entries: readonly string[]): { names: Set<string>; cidrs: CidrSet } {
  const names = new Set<string>();
  const cidrs = new CidrSet();
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === '') continue;
    const [bare = '', prefix] = entry.split('/');
    if (prefix !== undefined || isIP(stripAddress(bare)) !== 0) {
      const minimum = isIP(stripAddress(bare)) === 6 ? 16 : 8;
      if (prefix !== undefined && Number(prefix) < minimum) throw new TypeError(`SYMB_PRIVATE_HOSTS : « ${entry} » trop large (préfixe /${minimum} au minimum)`);
      cidrs.add(entry);
    } else if (/^[a-z0-9.-]+$/i.test(entry)) {
      names.add(normalizeHostname(entry));
    } else {
      throw new TypeError(`SYMB_PRIVATE_HOSTS : entrée invalide « ${entry} » (nom exact ou CIDR)`);
    }
  }
  return { names, cidrs };
}

export function createEgressGuard(options: EgressGuardOptions = {}): EgressGuard {
  const { names, cidrs } = parsePrivateHosts(options.privateHosts ?? []);
  const testAllowPrivate = options.testAllowPrivate === true;
  const resolver = options.resolver ?? defaultResolver;


  const checkAddress = (raw: string, address: string, port?: number): void => {
    const host = normalizeHostname(raw);
    const verdict = classifyAddress(address);
    if (verdict.allowed) return;
    if (!verdict.hard && (testAllowPrivate || names.has(host) || cidrs.has(verdict.address))) return;
    throw new EgressDeniedError('address_not_public', host, { ...(port === undefined ? {} : { port }), address: verdict.address, detail: verdict.reason });
  };

  const checkName = (raw: string, port?: number): void => {
    const host = normalizeHostname(raw);
    const excepted = testAllowPrivate || names.has(host);
    if (HARD_RESERVED_NAMES.has(host) || ((RESERVED_NAMES.has(host) || host.endsWith('.localhost')) && !excepted)) {
      throw new EgressDeniedError('address_not_public', host, { ...(port === undefined ? {} : { port }), detail: 'reserved_name' });
    }
    // Une IP littérale est déjà une adresse : contrôlée même quand le nom part à l'amont sans résolution locale.
    if (isIP(host) !== 0) checkAddress(host, host, port);
  };

  return {
    checkName,
    checkAddress,
    resolve: async (raw, port) => {
      const host = normalizeHostname(raw);
      checkName(host, port);
      const family = isIP(host);
      let records: readonly ResolvedAddress[];
      if (family !== 0) {
        records = [{ address: host, family: family === 6 ? 6 : 4 }];
      } else {
        try {
          records = await resolver(host);
        } catch {
          throw new EgressDeniedError('unresolvable', host, { port });
        }
      }
      if (records.length === 0) throw new EgressDeniedError('unresolvable', host, { port });
      // Une seule adresse hors de l'ensemble joignable suffit à refuser le nom.
      for (const record of records) checkAddress(host, record.address, port);
      const first = records[0] as ResolvedAddress;
      return { address: stripAddress(first.address), family: first.family };
    },
  };
}

/** Garde du nœud depuis sa configuration validée (tâche 0.4) : `SYMB_PRIVATE_HOSTS` et `SYMB_TEST_ALLOW_PRIVATE`. */
export function egressGuardFromConfig(config: Pick<BrowserConfig, 'privateHosts' | 'test'>, resolver?: Resolver): EgressGuard {
  return createEgressGuard({ privateHosts: config.privateHosts, testAllowPrivate: config.test.allowPrivate, ...(resolver === undefined ? {} : { resolver }) });
}
