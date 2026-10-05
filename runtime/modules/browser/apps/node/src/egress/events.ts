// SPDX-License-Identifier: AGPL-3.0-only
// Événements de l'egress (cdc/sym-browser 04c § 1.5) : `egress.blocked` émis aussitôt à la première occurrence d'un couple
// hôte et motif, puis répétitions agrégées par fenêtre (1 s par défaut, à valider) dans `count` ; `egress.budget_exceeded`
// une fois par époque. Données du contrat (`SessionEventData`) ; la session (tâches 1.2, 2.5) ajoute `sessionId` et `at`.
import type { EgressBlockReason, SessionEventData } from '@sym/contracts/browser';

export type EgressEvent =
  | { type: 'egress.blocked'; data: SessionEventData['egress.blocked'] }
  | { type: 'egress.budget_exceeded'; data: SessionEventData['egress.budget_exceeded'] };

/**
 * Couples (hôte, motif) distincts relevés par egress : au-delà, les refus nouveaux sont agrégés sous l'hôte `*` (le total reste
 * exact dans `count`). Une page qui sollicite des milliers de noms ne remplit ni `session_events` ni la mémoire du nœud (audit 5.3).
 */
export const MAX_DISTINCT_BLOCKED = 200;
const OTHER_HOSTS = '*';

type Window = { port: number | undefined; pending: number; timer: NodeJS.Timeout };

export type BlockedReporter = {
  report(host: string, reason: EgressBlockReason, port?: number): void;
  /** Émet les répétitions en attente et arrête les fenêtres (fermeture de l'egress). */
  flush(): void;
};

export function createBlockedReporter(emit: (event: EgressEvent) => void, windowMs = 1_000): BlockedReporter {
  const windows = new Map<string, Window>();
  const named = new Set<string>();
  const send = (host: string, reason: EgressBlockReason, port: number | undefined, count: number): void => {
    emit({ type: 'egress.blocked', data: { host, reason, ...(port === undefined ? {} : { port }), count } });
  };
  const open = (key: string, host: string, reason: EgressBlockReason, port: number | undefined): void => {
    const timer = setTimeout(() => {
      const window = windows.get(key);
      windows.delete(key);
      if (window !== undefined && window.pending > 0) {
        send(host, reason, window.port, window.pending);
        open(key, host, reason, window.port);
      }
    }, windowMs);
    timer.unref();
    windows.set(key, { port, pending: 0, timer });
  };
  return {
    report: (rawHost, reason, port) => {
      let host = rawHost;
      let key = `${reason}\u0000${host}`;
      if (!named.has(key)) {
        if (named.size < MAX_DISTINCT_BLOCKED) named.add(key);
        else {
          host = OTHER_HOSTS;
          key = `${reason}\u0000${host}`;
        }
      }
      const window = windows.get(key);
      if (window !== undefined) {
        window.pending += 1;
        window.port = port;
        return;
      }
      send(host, reason, port, 1);
      open(key, host, reason, port);
    },
    flush: () => {
      for (const [key, window] of windows) {
        clearTimeout(window.timer);
        const [reason = '', host = ''] = key.split('\u0000');
        if (window.pending > 0) send(host, reason as EgressBlockReason, window.port, window.pending);
      }
      windows.clear();
    },
  };
}
