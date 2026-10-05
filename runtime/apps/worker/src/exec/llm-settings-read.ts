// SPDX-License-Identifier: AGPL-3.0-only
// Lecture des réglages IA par le worker, avec la cause quand elle échoue (U1.12, UX-15). Avant : `config().catch(() => null)`
// confondait une lecture impossible (clé maîtresse différente de celle du web, fournisseur inconnu, rôle incomplet) avec
// « aucun réglage », puis le run se disait « prix manquant ». Ici la cause est un CODE FERMÉ : jamais le message de l'erreur
// (il peut nommer un fournisseur, un identifiant de secret ou le détail d'un déchiffrement ; INV8).
import { LlmSettingsError, type LlmConfig } from '@runtime/llm';

/** Raisons fermées de `llm_settings_unreadable` (publiées dans `error_detail` et dans l'événement de fin). */
export type LlmSettingsReason = 'key_unreadable' | 'provider_unknown' | 'role_incomplete' | 'provider_incomplete' | 'headers_unreadable' | 'settings_missing' | 'settings_invalid' | 'settings_read_failed';

/** Classe l'erreur de `llmConfigFromSettings` ; le texte source sert au classement seul et n'est jamais recopié. */
export function classifyLlmSettingsError(error: unknown): LlmSettingsReason {
  if (!(error instanceof LlmSettingsError)) return 'settings_read_failed';
  const m = error.message;
  if (m.includes('clé illisible')) return 'key_unreadable';
  if (m.includes('en-têtes')) return 'headers_unreadable';
  if (/fournisseur .+ inconnu/.test(m)) return 'provider_unknown';
  if (/^rôle .+ : provider et model attendus/.test(m)) return 'role_incomplete';
  if (m.includes('base_url et api_key_secret_id attendus')) return 'provider_incomplete';
  if (m === 'settings.llm absent') return 'settings_missing';
  return 'settings_invalid';
}

export type LlmConfigRead = { readonly kind: 'ok'; readonly config: LlmConfig | null } | { readonly kind: 'unreadable'; readonly code: LlmSettingsReason };

/** `config: null` : aucun réglage ou aucun port (cas « non configuré ») ; `unreadable` : la lecture a échoué, avec sa cause. */
export async function readLlmConfig(llm: { readonly config: () => Promise<LlmConfig | null> } | undefined): Promise<LlmConfigRead> {
  if (llm === undefined) return { kind: 'ok', config: null };
  try {
    return { kind: 'ok', config: await llm.config() };
  } catch (error) {
    return { kind: 'unreadable', code: classifyLlmSettingsError(error) };
  }
}
