// SPDX-License-Identifier: AGPL-3.0-only
// Contact d'instance manquant (17 § 5, UX-06) : requis avant la première enquête, il ne s'impose pas à l'assistant de premier
// démarrage ; la console le rappelle tant qu'il manque. Lu dans l'identité du robot (`GET /api/settings/identity`, réservée à
// ceux qui règlent l'identité : un membre n'en voit pas le rappel et ne la lit pas). « Manquant » = le serveur n'en résout
// aucun (ni réglage, ni variable du worker) ET un worker a publié son environnement ; sans publication, rien n'est inventé.
import { ref } from 'vue';
import { call } from '@/lib/api-call';
import { getApi } from '@/lib/api';
import { can } from '@/composables/useSession';

export function useInstanceContactStatus() {
  const missing = ref(false);

  async function load(): Promise<void> {
    if (!can('settings:identity:write')) return;
    const result = await call(() => getApi().GET('/api/settings/identity'));
    // Une lecture refusée ou en panne n'est pas un manque : aucun bandeau.
    missing.value = result.ok && result.data.engine !== null && result.data.instance_contact_effective === null;
  }

  return { missing, load };
}
