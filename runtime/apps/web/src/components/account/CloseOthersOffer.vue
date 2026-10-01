<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file CloseOthersOffer.vue
 * @description Proposition, en ligne, de fermer les autres sessions après un changement de mot de passe ou de 2FA (13 § 5,
 * ASVS 7.4.3). Rien n'est fermé d'office : un bouton ferme les autres sessions (la courante reste), « Pas maintenant » range la
 * proposition. Le résultat se lit en texte (`role="status"`).
 * @component
 * @example <CloseOthersOffer :count="2" @closed="sessions.reload()" @dismiss="offer = false" />
 */
import { useI18n } from 'vue-i18n';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useCloseOtherSessions } from '@/composables/useAccount';

/** `count` : nombre d'autres sessions connu (changement de mot de passe) ; absent après un changement de 2FA. */
const props = defineProps<{ count?: number }>();
const emit = defineEmits<{ closed: []; dismiss: [] }>();
const { t } = useI18n();
const others = useCloseOtherSessions();

async function close(): Promise<void> {
  if (await others.close()) emit('closed');
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-md border p-3" data-testid="close-others-offer">
    <p v-if="others.closed.value" role="status" class="text-sm">{{ t('account.closeOthers.closed') }}</p>
    <template v-else>
      <p class="text-sm font-medium">{{ t('account.closeOthers.title') }}</p>
      <p v-if="props.count !== undefined" class="text-sm">{{ t('account.closeOthers.count', { n: String(props.count) }, props.count) }}</p>
      <p class="text-sm text-muted-foreground">{{ t('account.closeOthers.text') }}</p>
      <Alert v-if="others.failure.value" variant="destructive"><AlertDescription>{{ t(others.failure.value) }}</AlertDescription></Alert>
      <div class="flex flex-wrap gap-2">
        <Button type="button" size="sm" class="aria-disabled:pointer-events-none aria-disabled:opacity-50" :aria-disabled="others.busy.value" @click="close()">{{ t('account.closeOthers.close') }}</Button>
        <Button type="button" size="sm" variant="outline" @click="emit('dismiss')">{{ t('account.closeOthers.later') }}</Button>
      </div>
    </template>
  </div>
</template>
