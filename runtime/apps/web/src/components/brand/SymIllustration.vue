<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file SymIllustration.vue
 * @description Carte d'illustration bleue des planches (3.21, 20 § 1.2, 1.4) : formes plates décoratives (cercle orange, carré
 * lilas, disque jaune), pastilles de la planche Démarrage (« FETCH », « NAVIGATEUR », « AGENT ») et, si `bubble` est fourni, la bulle
 * « SYM : … » (icône) (signature en icône, 20 § 2.3). Tout le décor est `aria-hidden` ; la bulle est du texte lu normalement. Jamais sur un
 * écran d'erreur, de blocage, de consentement ou de coût (20 § 2.3) : l'appelant ne la monte pas dans ces états.
 * @component
 * @example <SymIllustration :bubble="t('brand.bubble.onIt')" />
 */
import { SymSignature } from '@runtime/ui';
import { useI18n } from 'vue-i18n';

withDefaults(defineProps<{ bubble?: string; compact?: boolean }>(), { bubble: undefined, compact: false });
const { t, locale } = useI18n();
</script>

<template>
  <div class="relative overflow-hidden rounded-3xl bg-sym-blue" :class="compact ? 'min-h-48 w-full' : 'min-h-[22rem] w-full'" data-testid="sym-illustration">
    <div aria-hidden="true" class="absolute -bottom-20 -left-15 size-65 rounded-full bg-sym-orange" />
    <div aria-hidden="true" class="absolute -top-12 -right-10 size-55 rotate-18 rounded-[60px] bg-sym-lilac" />
    <div aria-hidden="true" class="absolute right-[4.5rem] bottom-10 size-22 rounded-full bg-sym-yellow" />
    <template v-if="!compact">
      <span aria-hidden="true" class="absolute bottom-[7.5rem] left-10 rounded-full border-[1.5px] border-sym-ink bg-sym-paper px-3.5 py-1.5 text-[13px] font-bold text-sym-ink uppercase">{{ t('brand.pills.fetch') }}</span>
      <span aria-hidden="true" class="absolute bottom-[4.5rem] left-[11.5rem] rounded-full border-[1.5px] border-sym-ink bg-sym-paper px-3.5 py-1.5 text-[13px] font-bold text-sym-ink uppercase">{{ t('brand.pills.browser') }}</span>
      <span aria-hidden="true" class="absolute top-52 right-12 rounded-full border-[1.5px] border-sym-ink bg-sym-paper px-3.5 py-1.5 text-[13px] font-bold text-sym-ink uppercase">{{ t('brand.pills.agent') }}</span>
    </template>
    <p v-if="bubble" class="absolute top-16 right-6 left-10 w-fit max-w-[calc(100%-3.5rem)] justify-self-end rounded-[16px_16px_4px_16px] bg-sym-ink px-4 py-3 font-display text-lg font-extrabold text-sym-paper sm:left-auto" data-sym-bubble>
      <SymSignature class="mr-1.5" variant="speaking" :locale="locale === 'fr' ? 'fr' : 'en'" />{{ bubble }}
    </p>
  </div>
</template>
