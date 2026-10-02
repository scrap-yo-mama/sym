<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<!-- Console de SYM Browser, squelette de la tâche 0.1 : écran d'attente aux couleurs du design system SYM (packages/ui). -->
<script setup lang="ts">
import { SymSignature } from '@runtime/ui';
import { useI18n } from 'vue-i18n';

const { t, locale } = useI18n();
</script>

<template>
  <main class="console" data-console-root>
    <h1>
      <SymSignature variant="badge" :locale="locale === 'fr' ? 'fr' : 'en'" />
      {{ t('app.title') }}
    </h1>
    <p>{{ t('app.soon') }}</p>
  </main>
</template>
