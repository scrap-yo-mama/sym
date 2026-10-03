// SPDX-License-Identifier: AGPL-3.0-only
// `settings.llm` (08 §7, contrat IA) vers `LlmConfig` : fournisseurs de l'admin, clés lues dans le dépôt de secrets
// (INV8 : jamais en clair dans `settings`), un modèle par rôle. Utilisé par le worker pour les rôles `extract` (E4, E5
// délégué) et `agent` (E6, tâche 2.4). Toute incohérence lève `LlmSettingsError` : l'essai échoue en `code_error`
// (`llm_not_configured`), jamais sur un fournisseur de repli implicite.
import { Secret } from '@runtime/core';
import type { LlmConfig, ModelConfig, ProviderConfig, RoleConfig } from './client.js';
import type { CapabilityProfile, LlmRole, StructuredMode, ToolChoiceMode } from './profile.js';
import type { RedactConfig } from './redact.js';
import type { ModelPrice } from './usage.js';

export class LlmSettingsError extends Error {
  override name = 'LlmSettingsError';
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const ROLES: readonly LlmRole[] = ['investigate', 'repair', 'extract', 'agent', 'judge', 'reflect', 'embed'];
const STRUCTURED: readonly StructuredMode[] = ['json_schema', 'tool_forced', 'json_object'];
const CHOICES: readonly ToolChoiceMode[] = ['auto', 'required', 'named'];

function profileOf(model: string, raw: unknown): CapabilityProfile | undefined {
  if (!isRecord(raw)) return undefined;
  const structured = typeof raw['structured'] === 'string' && (STRUCTURED as readonly string[]).includes(raw['structured']) ? (raw['structured'] as StructuredMode) : 'none';
  const choices = Array.isArray(raw['tool_choice']) ? raw['tool_choice'].filter((c): c is ToolChoiceMode => (CHOICES as readonly unknown[]).includes(c)) : [];
  const reasoning = raw['reasoning_field'] === 'reasoning_content' || raw['reasoning_field'] === 'reasoning' ? raw['reasoning_field'] : null;
  return {
    model,
    tools: raw['tools'] === true,
    tool_choice: choices,
    structured_modes: structured === 'none' ? [] : [structured],
    structured,
    stream_tools: typeof raw['stream_tools'] === 'boolean' ? raw['stream_tools'] : null,
    stream_usage: typeof raw['stream_usage'] === 'boolean' ? raw['stream_usage'] : null,
    cache: raw['cache'] === true,
    reasoning_field: reasoning,
    ...(isRecord(raw['sampling']) ? { sampling: { temperature: raw['sampling']['temperature'] !== false, top_p: raw['sampling']['top_p'] !== false } } : {}),
    probed_at: typeof raw['probed_at'] === 'string' ? raw['probed_at'] : '',
    probe_tokens: 0,
    notes: [],
  };
}

function priceOf(raw: unknown): ModelPrice | undefined {
  if (!isRecord(raw) || typeof raw['in'] !== 'number' || typeof raw['out'] !== 'number') return undefined;
  return {
    in: raw['in'],
    out: raw['out'],
    ...(typeof raw['in_cached'] === 'number' ? { in_cached: raw['in_cached'] } : {}),
    ...(typeof raw['in_cache_write'] === 'number' ? { in_cache_write: raw['in_cache_write'] } : {}),
  };
}

function roleOf(raw: unknown, name: string): RoleConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw) || typeof raw['provider'] !== 'string' || typeof raw['model'] !== 'string') throw new LlmSettingsError(`rôle ${name} : provider et model attendus`);
  const fb = raw['fallback'];
  return {
    provider: raw['provider'],
    model: raw['model'],
    ...(isRecord(fb) && typeof fb['provider'] === 'string' && typeof fb['model'] === 'string' ? { fallback: { provider: fb['provider'], model: fb['model'] } } : {}),
  };
}

/**
 * En-têtes propres au fournisseur (08 § 1), saisis par l'admin et chiffrés au dépôt (`headers_secret_id`, objet JSON
 * nom → valeur) : envoyés par chaque appel du client, comme par la sonde « Tester ». Illisibles ou malformés : refus
 * explicite (un fournisseur qui les exige échouerait sinon sur chaque run).
 */
async function headersOf(provider: string, secretId: string, readSecret: (id: string) => Promise<Secret>): Promise<Record<string, Secret>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readSecret(secretId)).reveal());
  } catch {
    throw new LlmSettingsError(`fournisseur ${provider} : en-têtes illisibles`);
  }
  if (!isRecord(parsed) || Object.values(parsed).some((v) => typeof v !== 'string')) throw new LlmSettingsError(`fournisseur ${provider} : en-têtes malformés`);
  return Object.fromEntries(Object.entries(parsed as Record<string, string>).map(([name, value]) => [name, new Secret(value)]));
}

/**
 * Configuration du client depuis `settings.llm`. Seuls les fournisseurs des `roles` demandés sont résolus (une clé
 * illisible d'un fournisseur inutilisé ne bloque pas l'essai).
 */
export async function llmConfigFromSettings(value: unknown, readSecret: (id: string) => Promise<Secret>, roles: readonly LlmRole[] = ROLES): Promise<LlmConfig> {
  if (!isRecord(value)) throw new LlmSettingsError('settings.llm absent');
  const rawRoles = isRecord(value['roles']) ? value['roles'] : {};
  const wanted: Partial<Record<LlmRole, RoleConfig>> = {};
  for (const role of roles) {
    const r = roleOf(rawRoles[role], role);
    if (r !== undefined) wanted[role] = r;
  }
  const needed = new Set(Object.values(wanted).flatMap((r) => [r.provider, ...(r.fallback === undefined ? [] : [r.fallback.provider])]));
  const providers: ProviderConfig[] = [];
  for (const raw of Array.isArray(value['providers']) ? value['providers'] : []) {
    if (!isRecord(raw) || typeof raw['id'] !== 'string' || !needed.has(raw['id'])) continue;
    const id = raw['id'];
    if (typeof raw['base_url'] !== 'string' || typeof raw['api_key_secret_id'] !== 'string') throw new LlmSettingsError(`fournisseur ${id} : base_url et api_key_secret_id attendus`);
    const models: ModelConfig[] = [];
    for (const [modelId, m] of Object.entries(isRecord(raw['models']) ? raw['models'] : {})) {
      const profile = profileOf(modelId, isRecord(m) ? m['profile'] : undefined);
      const price = priceOf(isRecord(m) ? m['price'] : undefined);
      models.push({ id: modelId, ...(profile === undefined ? {} : { profile }), ...(price === undefined ? {} : { price }) });
    }
    let apiKey: Secret;
    try {
      apiKey = await readSecret(raw['api_key_secret_id']);
    } catch {
      throw new LlmSettingsError(`fournisseur ${id} : clé illisible`);
    }
    const headers = typeof raw['headers_secret_id'] === 'string' ? await headersOf(id, raw['headers_secret_id'], readSecret) : undefined;
    providers.push({
      id,
      baseUrl: raw['base_url'],
      apiKey,
      ...(headers === undefined ? {} : { headers }),
      ...(typeof raw['timeout_ms'] === 'number' ? { timeoutMs: raw['timeout_ms'] } : {}),
      ...(isRecord(raw['extra_body']) ? { extraBody: raw['extra_body'] } : {}),
      models,
    });
  }
  for (const [role, r] of Object.entries(wanted)) {
    if (!providers.some((p) => p.id === r.provider)) throw new LlmSettingsError(`rôle ${role} : fournisseur ${r.provider} inconnu`);
  }
  const redactRaw = isRecord(value['redact']) ? value['redact'] : {};
  const redact: RedactConfig | undefined =
    redactRaw['enabled'] === true
      ? { patterns: Array.isArray(redactRaw['patterns']) ? redactRaw['patterns'].filter((p): p is string => typeof p === 'string' && !['email', 'phone'].includes(p)) : [] }
      : undefined;
  return { providers, roles: wanted, ...(redact === undefined ? {} : { redact }) };
}

/** Modèle, fournisseur et prix d'un rôle (moteur agentique : Stagehand reçoit base, clé et modèle). */
export function roleTarget(config: LlmConfig, role: LlmRole): { provider: ProviderConfig; model: ModelConfig | { id: string } } | undefined {
  const r = config.roles[role];
  if (r === undefined) return undefined;
  const provider = config.providers.find((p) => p.id === r.provider);
  if (provider === undefined) return undefined;
  return { provider, model: provider.models.find((m) => m.id === r.model) ?? { id: r.model } };
}

/** Réglages du juge et de la mémoire lus dans `settings.llm` (tâche 2.12) : tout est désactivé par défaut. */
export type QualitySettings = { readonly judgeEnabled: boolean; readonly embeddingsEnabled: boolean };

/**
 * `settings.llm.judge.enabled` (activé par l'admin, avec l'avertissement « juge non étalonné, avis consultatif ») et
 * `settings.llm.catalog_memory.embeddings` (étage 4, option désactivée : sans `pgvector`, elle reste grisée). Le juge
 * exige aussi un modèle affecté au rôle `judge`.
 */
export function qualitySettings(value: unknown): QualitySettings {
  if (!isRecord(value)) return { judgeEnabled: false, embeddingsEnabled: false };
  const roles = isRecord(value['roles']) ? value['roles'] : {};
  const judge = isRecord(value['judge']) ? value['judge'] : {};
  const memory = isRecord(value['catalog_memory']) ? value['catalog_memory'] : {};
  return { judgeEnabled: judge['enabled'] === true && isRecord(roles['judge']), embeddingsEnabled: memory['embeddings'] === true && isRecord(roles['embed']) };
}

/**
 * Mention fournisseur (08 §4 point 5, 19 §3) : fournisseurs qui recevront des extraits d'une API — rôles d'enquête,
 * réparation, extraction, agent, et `reflect` s'il est affecté ; `judge` s'il est activé ; `embed` si l'étage 4 l'est.
 */
export function providersReceiving(value: unknown): string[] {
  if (!isRecord(value)) return [];
  const roles = isRecord(value['roles']) ? value['roles'] : {};
  const q = qualitySettings(value);
  const order: LlmRole[] = ['investigate', 'repair', 'extract', 'agent', ...(q.judgeEnabled ? (['judge'] as const) : []), 'reflect', ...(q.embeddingsEnabled ? (['embed'] as const) : [])];
  const out: string[] = [];
  for (const role of order) {
    const r = roles[role];
    if (isRecord(r) && typeof r['provider'] === 'string' && !out.includes(r['provider'])) out.push(r['provider']);
  }
  return out;
}
