<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file BlockedPanel.vue
 * @description Panneau « Bloquée » (06 § 2, A7, INV6) : arrêt volontaire, pas une panne. Ton factuel, sans reproche, trois
 * parties (ce qui est arrivé, pourquoi on s'arrête, ce que tu peux faire) plus l'essai déclencheur et le coût déjà dépensé.
 * AUCUN bouton ni lien vers le tunnel, aucun bouton de relance, aucun réglage réseau : le seul bouton de reprise est
 * « Ré-enquêter » (manuel, transition 18). `assert_blocked_panel_no_tunnel_link` le vérifie sur le rendu.
 * Ni nom d'outil de protection ni description de ce que le site a détecté. Deux variantes : protection et refus d'accès ;
 * le robots.txt ne conditionne pas la collecte (D-91), aucune variante ne s'y rapporte.
 * @component
 * @example <BlockedPanel cause="blocked_by_protection" domain="exemple.test" :attempt="attempt" @reinvestigate="go" />
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { formatDateTime, formatUsd } from '@/lib/format';
import type { AttemptView, BlockCause } from '@/lib/investigation';

interface Props {
  /** Cause de l'arrêt (code stable de 06 § 4.2). */
  cause: BlockCause;
  /** Domaine du site ; null si inconnu. */
  domain: string | null;
  /** Date du blocage (ISO 8601). */
  at?: string | null;
  /** Essai déclencheur. */
  attempt?: AttemptView | null;
  /** Coût de l'enquête déjà dépensé. */
  costUsd?: number | null;
  /** Voie officielle trouvée par le rapport d'accès, si elle existe. */
  officialApiUrl?: string | null;
  /** Page « Usage responsable » (site de documentation, tâche 4.8). */
  responsibleUseHref?: string;
  /** Une ré-enquête est en cours de demande. */
  busy?: boolean;
}

const props = withDefaults(defineProps<Props>(), { at: null, attempt: null, costUsd: null, officialApiUrl: null, responsibleUseHref: '/docs/responsible-use/', busy: false });

interface Emits {
  /** L'utilisateur demande une ré-enquête (seule reprise offerte, manuelle). */
  (e: 'reinvestigate'): void;
  /** L'utilisateur veut lire les essais. */
  (e: 'viewTrials'): void;
}
const emit = defineEmits<Emits>();

const { t, locale } = useI18n();
const copied = ref(false);

/** Lien de la voie officielle : http(s) seulement (une valeur du serveur n'est jamais posée telle quelle dans un `href`). */
const officialHref = computed(() => {
  try {
    const url = new URL(props.officialApiUrl ?? '');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
});
const domainLabel = computed(() => props.domain ?? t('blocked.unknownDomain'));
const costLabel = computed(() => formatUsd(props.costUsd, locale.value) ?? t('blocked.cost.unknown'));
const variant = computed<'protection' | 'forbidden'>(() => (props.cause === 'forbidden' ? 'forbidden' : 'protection'));

const whatText = computed(() => {
  const params = { domain: domainLabel.value, cost: costLabel.value };
  if (!props.attempt) return t('blocked.what.generic', params);
  return t(`blocked.what.${variant.value}`, {
    ...params,
    date: formatDateTime(props.at, locale.value) ?? '—',
    n: props.attempt.index + 1,
    execution: t(`execution.${props.attempt.execution}`),
    network: t(`network.${props.attempt.network}`),
  });
});

async function copyTemplate(): Promise<void> {
  const text = t('blocked.template', { domain: domainLabel.value });
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}
</script>

<template>
  <section class="flex flex-col gap-4 rounded-xl border-2 border-dashed border-foreground bg-card p-6 text-card-foreground" aria-labelledby="blocked-title" data-testid="blocked-panel">
    <header class="flex items-start gap-3">
      <!-- Cercle barré : forme distincte de l'erreur (croix dans un octogone) ; le libellé porte le sens -->
      <span aria-hidden="true" class="text-2xl leading-none">⦸</span>
      <h2 id="blocked-title" class="text-2xl font-extrabold">{{ t('blocked.title', { domain: domainLabel }) }}</h2>
    </header>

    <div>
      <h3 class="font-medium">{{ t('blocked.what.heading') }}</h3>
      <p class="text-sm text-muted-foreground" data-testid="blocked-what">{{ whatText }}</p>
    </div>

    <div>
      <h3 class="font-medium">{{ t('blocked.why.heading') }}</h3>
      <p class="text-sm text-muted-foreground" data-testid="blocked-why">{{ t(`blocked.why.${variant}`) }}</p>
    </div>

    <div>
      <h3 class="font-medium">{{ t('blocked.todo.heading') }}</h3>
      <ol class="list-decimal pl-5 text-sm text-muted-foreground">
        <li>
          {{ t('blocked.todo.official') }}
          <a v-if="officialHref" :href="officialHref" rel="noopener noreferrer" class="text-foreground underline underline-offset-4">{{ t('blocked.officialApi') }}</a>
        </li>
        <li>{{ t('blocked.todo.other') }}</li>
        <li>{{ t('blocked.todo.contact') }}</li>
        <li>{{ t('blocked.todo.later') }}</li>
      </ol>
    </div>

    <div class="flex flex-wrap items-center gap-3">
      <Button type="button" variant="outline" data-testid="blocked-copy-template" @click="copyTemplate">{{ t('blocked.copyTemplate') }}</Button>
      <Button type="button" :aria-disabled="busy" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" data-testid="blocked-reinvestigate" @click="!busy && emit('reinvestigate')">
        {{ t('blocked.reinvestigate') }}
      </Button>
      <Button type="button" variant="outline" data-testid="blocked-view-trials" @click="emit('viewTrials')">{{ t('blocked.viewTrials') }}</Button>
      <a :href="responsibleUseHref" class="text-sm underline underline-offset-4" data-testid="blocked-why-link">{{ t('blocked.whyLink') }}</a>
      <span role="status" class="text-sm text-muted-foreground">{{ copied ? t('blocked.copied') : '' }}</span>
    </div>
  </section>
</template>
