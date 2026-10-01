<!-- SPDX-License-Identifier: AGPL-3.0-only -->
<script setup lang="ts">
/**
 * @file ApiSchemasTab.vue
 * @description Schémas d'entrée et de sortie (06 § 2) : arbre en lecture et saisie JSON de la sortie. Modifier la sortie
 * déclenche une ré-enquête, après confirmation, et n'est proposé que depuis `sain` ou `warning` (transitions 19 et 20) :
 * jamais sur une API `bloquee`, dont la seule reprise est Ré-enquêter (06 § 2, transition 18). La sortie et les `views` (colonnes affichées) sont distinctes. Pas de
 * réglage d'accès ici (INV11). Absents pour l'admin face à une API avec session d'autrui (métadonnées seules).
 * @component
 * @example <ApiSchemasTab :detail="detail" slug="zz-books" @updated="onUpdated" />
 */
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ConfirmPanel from '@/components/api/ConfirmPanel.vue';
import JsonTree from '@/components/api/JsonTree.vue';
import { Button } from '@/components/ui/button';
import { outputSchemaEditAllowed, useApiActions } from '@/composables/useApiActions';
import type { ApiDetail } from '@/composables/useApiDetail';

const props = defineProps<{ detail: ApiDetail; slug: string }>();
const emit = defineEmits<{ updated: [detail: ApiDetail] }>();
const { t, te } = useI18n();
const actions = useApiActions(() => props.slug);

const canEdit = computed(() => outputSchemaEditAllowed(props.detail.status));
const editing = ref(false);
const confirming = ref(false);
const text = ref('');
const invalid = ref(false);
const parsed = ref<Record<string, unknown> | null>(null);

function startEdit(): void {
  text.value = JSON.stringify(props.detail.output_schema ?? {}, null, 2);
  invalid.value = false;
  editing.value = true;
}

function review(): void {
  try {
    const value: unknown = JSON.parse(text.value);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('object');
    parsed.value = value as Record<string, unknown>;
    invalid.value = false;
    confirming.value = true;
  } catch {
    invalid.value = true;
  }
}

async function confirm(): Promise<void> {
  if (!parsed.value) return;
  const updated = await actions.updateOutputSchema(parsed.value);
  if (updated) {
    emit('updated', updated);
    editing.value = false;
    confirming.value = false;
  }
}

const errorText = computed(() => {
  const code = actions.error.value?.code;
  return actions.error.value ? (code && te(`apiErrors.${code}`) ? t(`apiErrors.${code}`) : t('apiErrors.generic')) : null;
});
</script>

<template>
  <div class="flex flex-col gap-6">
    <p v-if="detail.metadata_only" class="rounded-md border p-3 text-sm" data-testid="metadata-only">{{ t('detail.metadataOnly') }}</p>
    <template v-else>
      <section aria-labelledby="schema-input" class="flex flex-col gap-2">
        <h2 id="schema-input" class="text-lg font-semibold">{{ t('schemas.input') }}</h2>
        <JsonTree :value="detail.input_schema ?? {}" />
      </section>

      <section aria-labelledby="schema-output" class="flex flex-col gap-2">
        <h2 id="schema-output" class="text-lg font-semibold">{{ t('schemas.output') }}</h2>
        <JsonTree :value="detail.output_schema ?? {}" />
        <p v-if="!canEdit" class="text-sm text-muted-foreground" data-testid="edit-output-unavailable">{{ t('schemas.editUnavailable') }}</p>
        <div v-else-if="!editing">
          <Button variant="outline" size="sm" data-testid="edit-output" @click="startEdit">{{ t('schemas.edit') }}</Button>
        </div>
        <div v-else class="flex flex-col gap-2">
          <label for="schema-output-json" class="text-sm font-medium">{{ t('schemas.editLabel') }}</label>
          <textarea
            id="schema-output-json"
            v-model="text"
            rows="12"
            spellcheck="false"
            class="rounded-md border border-input bg-transparent p-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            :aria-invalid="invalid ? 'true' : 'false'"
            :aria-describedby="invalid ? 'schema-output-invalid' : undefined"
          />
          <p v-if="invalid" id="schema-output-invalid" role="alert" class="sym-error">{{ t('schemas.invalid') }}</p>
          <ConfirmPanel
            v-if="confirming"
            id="schema-confirm"
            :title="t('schemas.confirm.title')"
            :consequence="t('schemas.confirm.consequence')"
            :confirm-label="t('schemas.confirm.yes')"
            :pending="actions.pending.value === 'schema'"
            @confirm="confirm"
            @cancel="confirming = false"
          />
          <p v-if="errorText" role="alert" class="sym-error">{{ errorText }}</p>
          <div v-if="!confirming" class="flex gap-3">
            <Button size="sm" @click="review">{{ t('schemas.review') }}</Button>
            <Button variant="outline" size="sm" @click="editing = false">{{ t('ui.cancel') }}</Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="schema-views" class="flex flex-col gap-2">
        <h2 id="schema-views" class="text-lg font-semibold">{{ t('schemas.views') }}</h2>
        <p class="text-sm text-muted-foreground">{{ t('schemas.viewsHint') }}</p>
        <ul v-if="detail.views?.columns?.length" class="flex flex-wrap gap-2">
          <li v-for="column in detail.views.columns" :key="column" class="rounded-md bg-secondary px-2 py-0.5 font-mono text-xs">{{ column }}</li>
        </ul>
        <p v-else class="text-sm">{{ t('schemas.noViews') }}</p>
      </section>
    </template>
  </div>
</template>
