// SPDX-License-Identifier: AGPL-3.0-only
// Progression MCP (tâche 3.10, 05 § 1.2) : `notifications/progress` facultatif, dérivé de `investigation_events` (la source
// unique du récit, du SSE de la console et du replay). La valeur `progress` est le numéro d'ordre du dernier événement de
// l'enquête : elle ne peut que croître (`assert_progress_monotonic`) ; un numéro qui ne dépasse pas le précédent n'est
// jamais envoyé. Sans `progressToken` dans la requête, aucune notification (le client ne l'a pas demandée).
import { type McpLocale, narrativeCatalog } from './texts.js';
import { entryText } from './narrative.js';
import type { TimelineEntry } from '../rest/timeline.js';

/** Envoie une progression ; ignorée si elle ne dépasse pas la précédente. */
export type ProgressSink = (progress: number, message: string) => Promise<void>;

type Notifier = (notification: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message: string } }) => Promise<void>;

/** Progression strictement croissante au-dessus d'un envoi brut ; null sans jeton de progression. */
export function createProgressSink(token: string | number | undefined, notify: Notifier): ProgressSink | null {
  if (token === undefined) return null;
  let last = 0;
  return async (progress, message) => {
    if (!Number.isFinite(progress) || progress <= last) return;
    last = progress;
    await notify({ method: 'notifications/progress', params: { progressToken: token, progress, message } });
  };
}

/** Message de progression : le dernier jalon du récit (« 2/4 Reconnaître : … », 80 caractères au plus), sinon « l'enquête est en cours ». */
export function progressMessage(timeline: readonly TimelineEntry[], locale: McpLocale): string {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const entry = timeline[i]!;
    if (entry.kind === 'investigation') continue;
    const text = entryText(entry, locale);
    if (text !== null) return text;
  }
  return narrativeCatalog(locale).running;
}
