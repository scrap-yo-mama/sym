// SPDX-License-Identifier: AGPL-3.0-only
// Journal d'audit (06 § 2, 13 § 9) : liste filtrée à curseur serveur, export NDJSON réservé à l'owner. Les événements ne portent
// que des métadonnées (jamais de secret, de cookie, de contenu de dataset ni d'argument d'outil) : la console les affiche tels
// quels et n'a aucun moyen de demander davantage (INV5, A3).
import type { components, paths } from '@runtime/client';
import { reactive, ref } from 'vue';
import { usePagedList } from '@/composables/usePagedList';
import { getApi } from '@/lib/api';
import { unwrap } from '@/lib/api-result';

type Schemas = components['schemas'];
type AuditQuery = NonNullable<paths['/api/audit']['get']['parameters']['query']>;
type ExportQuery = NonNullable<paths['/api/audit/export']['get']['parameters']['query']>;
export type AuditEvent = Schemas['AuditEvent'];
export type AuditOutcome = Schemas['AuditOutcome'];
export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['success', 'denied', 'error'];

export type AuditFilters = { action: string; actor: string; outcome: '' | AuditOutcome; since: string; until: string };

/** Jour saisi (`2026-10-01`) → borne ISO : début du jour pour « du », fin du jour pour « au » (UTC). */
export function dayBound(day: string, edge: 'start' | 'end'): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  return edge === 'start' ? `${day}T00:00:00.000Z` : `${day}T23:59:59.999Z`;
}

export function useAudit() {
  const filters = reactive<AuditFilters>({ action: '', actor: '', outcome: '', since: '', until: '' });

  const events = usePagedList<AuditEvent>(async (cursor) => {
    const query: AuditQuery = { limit: 50 };
    if (filters.action.trim()) query.action = filters.action.trim();
    if (filters.actor) query.actor = filters.actor;
    if (filters.outcome) query.outcome = filters.outcome;
    const since = dayBound(filters.since, 'start');
    const until = dayBound(filters.until, 'end');
    if (since) query.since = since;
    if (until) query.until = until;
    if (cursor) query.cursor = cursor;
    const data = unwrap(await getApi().GET('/api/audit', { params: { query } }));
    return { items: data.events, nextCursor: data.next_cursor };
  });

  /** Comptes proposés dans le filtre « Compte » (première page). */
  const actors = ref<{ id: string; label: string }[]>([]);
  async function loadActors(): Promise<void> {
    try {
      const data = unwrap(await getApi().GET('/api/users', { params: { query: { limit: 200 } } }));
      actors.value = data.users.map((user) => ({ id: user.id, label: user.display_name ? `${user.display_name} (${user.email})` : user.email }));
    } catch {
      actors.value = [];
    }
  }

  function reset(): void {
    Object.assign(filters, { action: '', actor: '', outcome: '', since: '', until: '' });
    void events.refetch();
  }

  const exporting = ref(false);
  /** Clé i18n de l'échec d'export, sinon null. */
  const exportFailure = ref<string | null>(null);

  /** Export NDJSON (owner) : le journal complet de la période filtrée, téléchargé tel que le serveur le rend. */
  async function exportNdjson(): Promise<boolean> {
    exporting.value = true;
    exportFailure.value = null;
    try {
      const query: ExportQuery = {};
      const since = dayBound(filters.since, 'start');
      const until = dayBound(filters.until, 'end');
      if (since) query.since = since;
      if (until) query.until = until;
      const { data, response } = await getApi().GET('/api/audit/export', { params: { query }, parseAs: 'blob' });
      if (!response.ok || !(data instanceof Blob)) {
        exportFailure.value = 'audit.exportFailed';
        return false;
      }
      const url = URL.createObjectURL(data);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'audit.ndjson';
      link.click();
      URL.revokeObjectURL(url);
      return true;
    } catch {
      exportFailure.value = 'audit.exportFailed';
      return false;
    } finally {
      exporting.value = false;
    }
  }

  return { filters, events, actors, loadActors, reset, exporting, exportFailure, exportNdjson };
}
