// SPDX-License-Identifier: AGPL-3.0-only
// Domaine d'un site connecté par l'extension (07 § 2, § 5, INV10) : nom d'hôte normalisé (minuscules, punycode, sans
// port ni point final). Refus avant tout enregistrement : adresses IP privées ou réservées, `localhost`, `*.local`,
// noms internes et métadonnées cloud, noms sans point (intranet). Même règle côté extension (apps/extension, test de
// parité) et côté instance : un domaine refusé ici n'est jamais connecté, même si l'extension a été modifiée.
import { isIP } from 'node:net';
import { classifyAddress } from './ip.js';

export type SiteDomainVerdict =
  | { ok: true; domain: string }
  | { ok: false; reason: 'invalid' | 'private_address' | 'internal_name' };

/** Suffixes réservés aux réseaux locaux ou internes (RFC 6761, 6762, 8375 ; métadonnées cloud). */
const INTERNAL_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home.arpa', 'localdomain', 'corp'];
const INTERNAL_NAMES = new Set(['localhost', 'metadata.google.internal', 'metadata.goog', 'metadata']);
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function internalName(host: string): boolean {
  if (INTERNAL_NAMES.has(host)) return true;
  return INTERNAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Normalise et contrôle un domaine saisi (nom d'hôte seul, ou URL http(s) dont on garde l'hôte). Aucune dérogation. */
export function checkSiteDomain(raw: string): SiteDomainVerdict {
  const input = raw.trim();
  if (input === '' || input.length > 2048) return { ok: false, reason: 'invalid' };
  let host: string;
  try {
    const url = /^https?:\/\//i.test(input) ? new URL(input) : new URL(`http://${input}`);
    if (url.username !== '' || url.password !== '') return { ok: false, reason: 'invalid' };
    if (!/^https?:\/\//i.test(input) && (url.port !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '')) {
      return { ok: false, reason: 'invalid' };
    }
    host = url.hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (host.startsWith('[')) return { ok: false, reason: 'private_address' }; // littéral IPv6 : jamais un site connecté
  if (isIP(host) === 4) {
    return classifyAddress(host).allowed ? { ok: true, domain: host } : { ok: false, reason: 'private_address' };
  }
  if (host.length > 253 || !host.split('.').every((label) => LABEL.test(label))) return { ok: false, reason: 'invalid' };
  // Un nom entièrement numérique (ex. 2130706433, 0x7f.1) est un encodage d'IP : refusé.
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) return { ok: false, reason: 'private_address' };
  if (!host.includes('.') || internalName(host)) return { ok: false, reason: 'internal_name' };
  return { ok: true, domain: host };
}
