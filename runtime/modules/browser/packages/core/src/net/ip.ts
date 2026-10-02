// SPDX-License-Identifier: AGPL-3.0-only
// Classement d'une adresse IP résolue (cdc/sym-browser 04c § 1.2), pur et sans I/O. Réimplémentation dans le module de la
// classification de SYM (`runtime/packages/core/src/net/ip.ts`, lue sans être importée : frontière du module), mêmes
// registres IANA et mêmes classes dures. La décision porte toujours sur l'adresse résolue, jamais sur la chaîne de l'URL.
import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net';

/** Classe d'une adresse refusée (détail du journal ; le navigateur ne voit que `address_not_public`). */
export type BlockReason =
  | 'cloud_metadata'
  | 'unspecified'
  | 'broadcast'
  | 'multicast'
  | 'loopback'
  | 'private'
  | 'shared_cgnat'
  | 'link_local'
  | 'unique_local'
  | 'site_local'
  | 'reserved'
  | 'documentation'
  | 'benchmarking'
  | 'protocol_assignments'
  | 'discard'
  | 'nat64_local'
  | 'invalid';

export type AddressVerdict =
  | { allowed: true; address: string; family: 4 | 6 }
  | { allowed: false; address: string; reason: BlockReason; hard: boolean; embeddedIPv4?: string };

/**
 * Classes jamais dérogeables, même par SYMB_PRIVATE_HOSTS ou le drapeau de test (04c § 1.2, point 5) :
 * métadonnées cloud, adresse non spécifiée (0.0.0.0 vise la machine locale sous Linux), diffusion, multicast.
 */
export const HARD_BLOCK_REASONS: ReadonlySet<BlockReason> = new Set<BlockReason>([
  'cloud_metadata',
  'unspecified',
  'broadcast',
  'multicast',
  'invalid',
]);

type Rule = readonly [cidr: string, reason: BlockReason];

// Services de métadonnées (IMDS) connus, IPv4 et IPv6.
const METADATA_V4: readonly string[] = [
  '169.254.169.254', // AWS, GCP, Azure, OpenStack, DigitalOcean, Oracle
  '169.254.170.2', // AWS ECS (identifiants de tâche)
  '169.254.170.23', // AWS EKS Pod Identity
  '100.100.100.200', // Alibaba Cloud
];
const METADATA_V6: readonly string[] = ['fd00:ec2::254', 'fd00:ec2::23'];

// Registre IANA des adresses à usage spécial (IPv4), tout ce qui n'est pas « globalement joignable ».
const V4_RULES: readonly Rule[] = [
  ['0.0.0.0/8', 'unspecified'],
  ['10.0.0.0/8', 'private'],
  ['100.64.0.0/10', 'shared_cgnat'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link_local'],
  ['172.16.0.0/12', 'private'],
  ['192.0.0.0/24', 'protocol_assignments'],
  ['192.0.2.0/24', 'documentation'],
  ['192.31.196.0/24', 'reserved'], // AS112-v4
  ['192.52.193.0/24', 'reserved'], // AMT
  ['192.88.99.0/24', 'reserved'], // relais 6to4 (déprécié)
  ['192.168.0.0/16', 'private'],
  ['192.175.48.0/24', 'reserved'], // AS112 direct delegation
  ['198.18.0.0/15', 'benchmarking'],
  ['198.51.100.0/24', 'documentation'],
  ['203.0.113.0/24', 'documentation'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
];

// Registre IANA IPv6. ::ffff:0:0/96, 64:ff9b::/96 et 2002::/16 sont traités à part (IPv4 intégrée extraite).
const V6_RULES: readonly Rule[] = [
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
  ['::/96', 'reserved'], // IPv4-compatible (déprécié)
  ['64:ff9b:1::/48', 'nat64_local'],
  ['100::/64', 'discard'],
  ['2001::/23', 'protocol_assignments'], // Teredo, ORCHID, AS112… : refusés en bloc
  ['2001:db8::/32', 'documentation'],
  ['3fff::/20', 'documentation'],
  ['5f00::/16', 'reserved'], // SRv6 SIDs
  ['fc00::/7', 'unique_local'],
  ['fe80::/10', 'link_local'],
  ['fec0::/10', 'site_local'],
  ['ff00::/8', 'multicast'],
];

function buildList(entries: readonly string[], type: 'ipv4' | 'ipv6'): BlockList {
  const list = new BlockList();
  for (const entry of entries) {
    const [network = '', prefix] = entry.split('/');
    if (prefix === undefined) list.addAddress(network, type);
    else list.addSubnet(network, Number(prefix), type);
  }
  return list;
}

function buildRules(rules: readonly Rule[], type: 'ipv4' | 'ipv6'): (readonly [BlockList, BlockReason])[] {
  return rules.map(([cidr, reason]) => [buildList([cidr], type), reason] as const);
}

const METADATA_V4_LIST = buildList(METADATA_V4, 'ipv4');
const METADATA_V6_LIST = buildList(METADATA_V6, 'ipv6');
const V4 = buildRules(V4_RULES, 'ipv4');
const V6 = buildRules(V6_RULES, 'ipv6');

/** Retire les crochets d'un littéral IPv6 d'URL et l'identifiant de zone (`fe80::1%eth0`). */
export function stripAddress(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  const zone = value.indexOf('%');
  if (zone !== -1 && isIPv6(value)) value = value.slice(0, zone);
  return value;
}

/** Octets d'une adresse IPv6 valide (formes compressées et IPv4 finale en notation pointée comprises). */
function ipv6ToBytes(address: string): Uint8Array {
  let text: string = stripAddress(address).toLowerCase();
  if (!isIPv6(text)) throw new TypeError(`IPv6 invalide : ${address}`);
  // IPv4 finale en notation pointée → deux groupes hexadécimaux.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted !== null) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', rest] = text.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const restGroups = rest === undefined || rest === '' ? [] : rest.split(':');
  const fill = rest === undefined ? 0 : 8 - headGroups.length - restGroups.length;
  const groups = [...headGroups, ...Array<string>(fill).fill('0'), ...restGroups];
  const bytes = new Uint8Array(16);
  groups.forEach((group, i) => {
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  });
  return bytes;
}

function v4FromBytes(bytes: Uint8Array, offset: number): string {
  return [0, 1, 2, 3].map((i) => bytes[offset + i] ?? 0).join('.');
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, i) => bytes[i] === value);
}

/** IPv4 intégrée dans une IPv6 : mappée (::ffff:0:0/96), SIIT (::ffff:0:0:0/96), NAT64 (64:ff9b::/96), 6to4 (2002::/16). */
function embeddedIPv4(address: string): string | undefined {
  const bytes = ipv6ToBytes(address);
  if (startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff])) return v4FromBytes(bytes, 12);
  if (startsWith(bytes, [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0])) return v4FromBytes(bytes, 12);
  if (startsWith(bytes, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) return v4FromBytes(bytes, 12);
  if (startsWith(bytes, [0x20, 0x02])) return v4FromBytes(bytes, 2);
  return undefined;
}

function classifyV4(address: string): BlockReason | undefined {
  if (METADATA_V4_LIST.check(address, 'ipv4')) return 'cloud_metadata';
  if (address === '255.255.255.255') return 'broadcast';
  for (const [list, reason] of V4) if (list.check(address, 'ipv4')) return reason;
  return undefined;
}

/**
 * Verdict sur une adresse résolue. Toute chaîne qui n'est pas une IP au sens de net.isIP est refusée
 * (`invalid`) : la classification ne devine jamais un encodage.
 */
export function classifyAddress(raw: string): AddressVerdict {
  const address = stripAddress(raw);
  const family = isIP(address);
  if (family === 4) {
    const reason = classifyV4(address);
    return reason === undefined ? { allowed: true, address, family: 4 } : { allowed: false, address, reason, hard: HARD_BLOCK_REASONS.has(reason) };
  }
  if (family === 6) {
    if (METADATA_V6_LIST.check(address, 'ipv6')) return { allowed: false, address, reason: 'cloud_metadata', hard: true };
    const v4 = embeddedIPv4(address);
    if (v4 !== undefined) {
      const reason = classifyV4(v4);
      return reason === undefined
        ? { allowed: true, address, family: 6 }
        : { allowed: false, address, reason, hard: HARD_BLOCK_REASONS.has(reason), embeddedIPv4: v4 };
    }
    for (const [list, reason] of V6) if (list.check(address, 'ipv6')) return { allowed: false, address, reason, hard: HARD_BLOCK_REASONS.has(reason) };
    return { allowed: true, address, family: 6 };
  }
  return { allowed: false, address, reason: 'invalid', hard: true };
}

/** Liste de CIDR ou d'adresses (dérogations SYMB_PRIVATE_HOSTS) testée sur l'adresse et son IPv4 intégrée. */
export class CidrSet {
  readonly #list = new BlockList();
  #size = 0;

  add(entry: string): void {
    const [rawNetwork = '', prefix] = entry.split('/');
    const network = stripAddress(rawNetwork);
    const type = isIPv4(network) ? 'ipv4' : isIPv6(network) ? 'ipv6' : undefined;
    if (type === undefined) throw new TypeError(`CIDR invalide : ${entry}`);
    if (prefix === undefined) {
      this.#list.addAddress(network, type);
    } else {
      const bits = Number(prefix);
      if (!/^\d+$/.test(prefix) || bits > (type === 'ipv4' ? 32 : 128)) throw new TypeError(`CIDR invalide : ${entry}`);
      this.#list.addSubnet(network, bits, type);
    }
    this.#size += 1;
  }

  get size(): number {
    return this.#size;
  }

  has(raw: string): boolean {
    const address = stripAddress(raw);
    if (isIPv4(address)) return this.#list.check(address, 'ipv4');
    if (!isIPv6(address)) return false;
    if (this.#list.check(address, 'ipv6')) return true;
    const v4 = embeddedIPv4(address);
    return v4 !== undefined && this.#list.check(v4, 'ipv4');
  }
}
