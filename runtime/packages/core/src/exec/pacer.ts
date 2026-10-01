// SPDX-License-Identifier: AGPL-3.0-only
// Branchement de la cadence par domaine (1.9) sur l'interpréteur : la clé reste le domaine de la cible, jamais le
// barreau réseau, le proxy ni le compte (`assert_pacing_key_is_domain`). Un 429 ralentit, il ne change pas de réseau ; un refus
// (403, défi) compte pour le disjoncteur du domaine comme un 429 (1.7, 04 §7).
import type { DomainPacer } from '../pacing/pacer.js';
import { outcomeKindOfResponse } from '../pacing/policy.js';
import type { RequestPacer } from './types.js';

export type DomainPacingSettings = {
  /** `domain_pacing.min_delay_ms` de l'API. */
  readonly minDelayMs?: number;
  /** `domain_pacing.max_wait_ms` de l'API. */
  readonly maxWaitMs?: number;
  /** `Crawl-delay` de robots.txt (module d'accès, 1.11). */
  readonly crawlDelayMs?: number | null;
};

export function domainRequestPacer(pacer: DomainPacer, settings: DomainPacingSettings = {}): RequestPacer {
  return {
    async acquire(url) {
      const grant = await pacer.acquire(url, {
        ...(settings.minDelayMs === undefined ? {} : { minDelayMs: settings.minDelayMs }),
        ...(settings.maxWaitMs === undefined ? {} : { maxWaitMs: settings.maxWaitMs }),
        ...(settings.crawlDelayMs === undefined ? {} : { crawlDelayMs: settings.crawlDelayMs }),
      });
      return grant.granted ? { granted: true } : { granted: false, reason: grant.reason, retryAt: grant.retryAt };
    },
    async report(url, response) {
      await pacer.report(url, { kind: outcomeKindOfResponse(response.status, response.failureClass), retryAfter: response.retryAfter });
    },
  };
}
