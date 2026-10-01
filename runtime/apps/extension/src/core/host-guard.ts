// SPDX-License-Identifier: AGPL-3.0-only
// Garde des domaines côté extension (07 § 5, INV10) : même règle que `checkSiteDomain` de l'instance
// (packages/core/src/net/site-domain.ts), sans dépendance Node ; la parité est vérifiée par host-guard.unit.test.ts.
// L'extension refuse les IP privées ou réservées, `localhost`, `*.local`, les noms internes et les métadonnées cloud,
// même pour un domaine que l'utilisateur voudrait connecter.

export type HostVerdict = { ok: true; domain: string } | { ok: false; reason: 'invalid' | 'private_address' | 'internal_name' };

const INTERNAL_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home.arpa', 'localdomain', 'corp'];
const INTERNAL_NAMES = new Set(['localhost', 'metadata.google.internal', 'metadata.goog', 'metadata']);
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Plages IPv4 non publiques (registre IANA des adresses à usage spécial, comme `classifyAddress`). */
const V4_BLOCKED: readonly (readonly [number, number])[] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4], ['100.100.100.200', 32],
].map(([net, bits]) => [toInt(net as string)!, bits as number] as const);

function toInt(ip: string): number | undefined {
  const m = IPV4.exec(ip);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return undefined;
  return parts.reduce((acc, p) => acc * 256 + p, 0);
}

function privateV4(ip: string): boolean {
  const n = toInt(ip);
  if (n === undefined) return true;
  return V4_BLOCKED.some(([net, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(net / 2 ** (32 - bits)));
}

function internalName(host: string): boolean {
  if (INTERNAL_NAMES.has(host)) return true;
  return INTERNAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Contrôle un domaine (nom d'hôte seul, ou URL http(s) dont on garde l'hôte). */
export function checkHost(raw: string): HostVerdict {
  const input = raw.trim();
  if (input === '' || input.length > 2048) return { ok: false, reason: 'invalid' };
  const isUrl = /^https?:\/\//i.test(input);
  let host: string;
  try {
    const url = new URL(isUrl ? input : `http://${input}`);
    if (url.username !== '' || url.password !== '') return { ok: false, reason: 'invalid' };
    if (!isUrl && (url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '')) return { ok: false, reason: 'invalid' };
    host = url.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (host.startsWith('[')) return { ok: false, reason: 'private_address' };
  if (IPV4.test(host)) return privateV4(host) ? { ok: false, reason: 'private_address' } : { ok: true, domain: host };
  if (host.length > 253 || !host.split('.').every((label) => LABEL.test(label))) return { ok: false, reason: 'invalid' };
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return { ok: false, reason: 'private_address' };
  if (!host.includes('.') || internalName(host)) return { ok: false, reason: 'internal_name' };
  return { ok: true, domain: host };
}

/** Domaine d'un onglet http(s), ou `null` (pages internes, extension, fichier, domaine refusé). */
export function siteDomainOf(tabUrl: string | undefined): string | null {
  if (!tabUrl || !/^https?:\/\//i.test(tabUrl)) return null;
  const verdict = checkHost(tabUrl);
  return verdict.ok ? verdict.domain : null;
}

/** Motifs d'hôte demandés en `optional_host_permissions` pour un domaine connecté (http et https, tous ports). */
export function originPatterns(domain: string): string[] {
  return [`https://${domain}/*`, `http://${domain}/*`];
}
