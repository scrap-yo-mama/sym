// SPDX-License-Identifier: AGPL-3.0-only
// Réglages > Navigateur (tâche 4.7 ; cdc/sym-browser 04g §3) : fournisseur de navigateur publié par le worker, en lecture seule.
import type { components } from '@runtime/client';
import { useResource } from '@/composables/useResource';
import { getApi } from '@/lib/api';
import { call } from '@/lib/api-call';

export type BrowserSettings = components['schemas']['BrowserSettings'];

export function useBrowserSettings() {
  const resource = useResource<BrowserSettings>(() => call(() => getApi().GET('/api/settings/browser')));
  return { data: resource.data, loading: resource.loading, failure: resource.failure, forbidden: resource.forbidden, load: resource.reload };
}
