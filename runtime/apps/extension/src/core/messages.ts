// SPDX-License-Identifier: AGPL-3.0-only
// Messages du popup vers le service worker : jeu fermé, validé à la réception (aucun code ni URL arbitraire exécuté).
import type { SiteMode } from './controller.ts';

export type Request =
  | { type: 'status' }
  | { type: 'pair'; instanceUrl: string; code: string; deviceLabel: string | null }
  | { type: 'connectSite'; domain: string; mode: SiteMode }
  | { type: 'disconnectSite'; domain: string }
  | { type: 'unpair' };

export type Response<T = unknown> = { ok: true; data: T } | { ok: false; code: string; message: string };

const str = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length <= max;

/** Valide un message reçu ; `null` s'il ne fait pas partie du jeu fermé. */
export function parseRequest(raw: unknown): Request | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'status':
    case 'unpair':
      return { type: m.type };
    case 'pair':
      return str(m.instanceUrl) && str(m.code, 64) && (m.deviceLabel === null || str(m.deviceLabel, 100))
        ? { type: 'pair', instanceUrl: m.instanceUrl, code: m.code, deviceLabel: m.deviceLabel }
        : null;
    case 'connectSite':
      return str(m.domain, 253) && (m.mode === 'tunnel' || m.mode === 'server') ? { type: 'connectSite', domain: m.domain, mode: m.mode } : null;
    case 'disconnectSite':
      return str(m.domain, 253) ? { type: 'disconnectSite', domain: m.domain } : null;
    default:
      return null;
  }
}
