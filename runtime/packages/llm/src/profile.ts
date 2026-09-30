// SPDX-License-Identifier: AGPL-3.0-only
// Profil de capacités par couple fournisseur x modèle (08 §1) et sonde de 3 appels minuscules.
import { LlmError } from './errors.js';
import type { ChatRequest, ChatResult, LlmTransport, ToolDef } from './types.js';

export type StructuredMode = 'json_schema' | 'tool_forced' | 'json_object';
export type ToolChoiceMode = 'auto' | 'required' | 'named';
export type LlmRole = 'investigate' | 'repair' | 'extract' | 'agent';

export interface CapabilityProfile {
  model: string;
  /** Appel d'outils fonctionnel. */
  tools: boolean;
  /** Formes de `tool_choice` vérifiées. Vide => ne jamais forcer (z.ai, Ollama, Qwen). */
  tool_choice: ToolChoiceMode[];
  /** Mécanismes de sortie structurée vérifiés (ou acceptés pour `json_object`). */
  structured_modes: StructuredMode[];
  /** Meilleur mécanisme, ou `none` (=> S4). */
  structured: StructuredMode | 'none';
  /** Non mesuré par la sonde (elle est en `stream: false`) : null = inconnu. */
  stream_tools: boolean | null;
  stream_usage: boolean | null;
  /** Le fournisseur rend `cached_tokens`. */
  cache: boolean;
  reasoning_field: 'reasoning_content' | 'reasoning' | null;
  probed_at: string;
  /** Jetons consommés par la sonde. */
  probe_tokens: number;
  notes: string[];
}

export const PROBE_MAX_TOKENS = 280;
/** Modèles à raisonnement : 280 jetons peuvent être épuisés par la réflexion (constaté sur GLM-5.3, DeepInfra). Un seul nouvel essai. */
export const PROBE_RETRY_MAX_TOKENS = 1200;

const PING: ToolDef = {
  type: 'function',
  function: {
    name: 'ping',
    description: 'Reply to a ping.',
    parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false },
  },
};

const PROBE_SCHEMA = {
  type: 'object',
  properties: { n: { type: 'integer' } },
  required: ['n'],
  additionalProperties: false,
};

function toolCallWorks(result: ChatResult): boolean {
  const call = result.message.tool_calls?.[0];
  if (call === undefined || call.function.name !== 'ping') return false;
  try {
    JSON.parse(call.function.arguments);
    return true;
  } catch {
    return false;
  }
}

function jsonSchemaWorks(result: ChatResult): boolean {
  if (typeof result.message.content !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(result.message.content.trim());
    return typeof parsed === 'object' && parsed !== null && Number.isInteger((parsed as { n?: unknown }).n);
  } catch {
    return false;
  }
}

/** Erreurs qui ne disent rien du modèle : la sonde échoue au lieu de conclure « non supporté ». */
const INCONCLUSIVE = new Set(['auth', 'quota_exhausted', 'network', 'timeout', 'overloaded', 'rate_limited', 'stream_error']);

/**
 * Sonde (action de l'admin, INV9 : ne contacte que le fournisseur configuré) : 3 appels, `stream: false`.
 * 1. outil en `tool_choice: auto` ; 2. `response_format: json_schema` strict ; 3. outil nommé forcé.
 */
export async function probeCapabilities(transport: LlmTransport, model: string, now: () => Date = () => new Date()): Promise<CapabilityProfile> {
  const notes: string[] = [];
  let tokens = 0;
  let cache = false;
  let reasoning: CapabilityProfile['reasoning_field'] = null;

  const observe = (r: ChatResult | undefined): void => {
    if (r === undefined) return;
    tokens += (r.usage?.prompt_tokens ?? 0) + (r.usage?.completion_tokens ?? 0);
    if (r.usage?.prompt_tokens_details?.cached_tokens !== undefined || r.usage?.prompt_cache_hit_tokens !== undefined) cache = true;
    if (typeof r.message['reasoning_content'] === 'string') reasoning = 'reasoning_content';
    else if (typeof r.message['reasoning'] === 'string' && reasoning === null) reasoning = 'reasoning';
  };

  const attempt = async (label: string, req: ChatRequest): Promise<{ result?: ChatResult; error?: LlmError }> => {
    try {
      let result: ChatResult;
      try {
        result = await transport.chat({ ...req, model, stream: false, max_tokens: PROBE_MAX_TOKENS });
      } catch (error) {
        if (!(error instanceof LlmError) || error.class !== 'truncated') throw error;
        // Troncature : inconclusif, pas « non supporté ». La réflexion a mangé le budget ; on compte ses jetons puis on réessaie.
        observe(error.partial);
        notes.push(`${label}: tronqué à ${PROBE_MAX_TOKENS} jetons (raisonnement), nouvel essai à ${PROBE_RETRY_MAX_TOKENS}`);
        result = await transport.chat({ ...req, model, stream: false, max_tokens: PROBE_RETRY_MAX_TOKENS });
      }
      observe(result);
      return { result };
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      if (INCONCLUSIVE.has(error.policyClass)) throw error;
      if (error.partial !== undefined) observe(error.partial);
      else if (error.usage !== null) tokens += (error.usage.prompt_tokens ?? 0) + (error.usage.completion_tokens ?? 0);
      notes.push(`${label}: ${error.class}`);
      return { error };
    }
  };

  const one = await attempt('tools_auto', {
    model,
    messages: [{ role: 'user', content: 'Call the function ping with n=1.' }],
    tools: [PING],
    tool_choice: 'auto',
  });
  const tools = one.result !== undefined && toolCallWorks(one.result);
  if (one.result !== undefined && !tools) notes.push('tools_auto: pas d\'appel d\'outil');

  const two = await attempt('json_schema', {
    model,
    messages: [{ role: 'user', content: 'Reply with exactly this JSON object and nothing else: {"n": 2}' }],
    response_format: { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema: PROBE_SCHEMA } },
  });
  const jsonSchema = two.result !== undefined && jsonSchemaWorks(two.result);
  if (two.result !== undefined && !jsonSchema) notes.push('json_schema: accepté mais réponse hors schéma (prose)');

  const three = await attempt('tool_forced', {
    model,
    messages: [{ role: 'user', content: 'Call the function ping with n=3.' }],
    tools: [PING],
    tool_choice: { type: 'function', function: { name: 'ping' } },
  });
  const forced = three.result !== undefined && toolCallWorks(three.result);

  const tool_choice: ToolChoiceMode[] = [];
  if (tools) tool_choice.push('auto');
  if (forced) tool_choice.push('named');

  const structured_modes: StructuredMode[] = [];
  if (jsonSchema) structured_modes.push('json_schema');
  if (forced) structured_modes.push('tool_forced');
  // `json_object` n'est pas sondé (3 appels) : accepté dès que `response_format` n'a pas été rejeté en 4xx.
  if (two.error === undefined) structured_modes.push('json_object');
  else if (two.error.class !== 'bad_request') structured_modes.push('json_object');

  return {
    model,
    tools,
    tool_choice,
    structured_modes,
    structured: structured_modes[0] ?? 'none',
    stream_tools: null,
    stream_usage: null,
    cache,
    reasoning_field: reasoning,
    probed_at: now().toISOString(),
    probe_tokens: tokens,
    notes,
  };
}

/** Ce que chaque rôle exige du profil (refus à l'affectation, 08 §1). */
export function roleProblems(role: LlmRole, profile: CapabilityProfile | undefined): string[] {
  if (role === 'agent') {
    if (profile === undefined) return ['profil de capacités absent : lancer la sonde avant d\'affecter le rôle agent'];
    if (!profile.tools) return ['le rôle agent exige l\'appel d\'outils (profil : tools=false)'];
  }
  return [];
}

/** `tool_choice` dérivé du profil : jamais forcé si le profil ne le confirme pas. */
export function resolveToolChoice(profile: CapabilityProfile | undefined, wanted: 'auto' | 'required' | { name: string }): ChatRequest['tool_choice'] {
  if (profile === undefined) return undefined;
  if (wanted === 'auto') return profile.tool_choice.includes('auto') ? 'auto' : undefined;
  if (wanted === 'required') return profile.tool_choice.includes('required') ? 'required' : undefined;
  return profile.tool_choice.includes('named') ? { type: 'function', function: { name: wanted.name } } : undefined;
}
