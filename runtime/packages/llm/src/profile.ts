// SPDX-License-Identifier: AGPL-3.0-only
// Profil de capacités par couple fournisseur x modèle (08 §1) et sonde de 3 appels minuscules.
import { LlmError } from './errors.js';
import type { ChatRequest, ChatResult, LlmTransport, ToolDef } from './types.js';

export type StructuredMode = 'json_schema' | 'tool_forced' | 'json_object';
export type ToolChoiceMode = 'auto' | 'required' | 'named';
/**
 * Rôles (08 §1). `judge` (juge de qualité consultatif, désactivé par défaut), `reflect` (propositions de règles, toujours
 * validées par un humain) et `embed` (embeddings de l'étage 4 de la mémoire, option désactivée) : tâche 2.12.
 */
export type LlmRole = 'investigate' | 'repair' | 'extract' | 'agent' | 'judge' | 'reflect' | 'embed';

/** Paramètres d'échantillonnage que le fournisseur accepte pour ce modèle (claude-opus-4-8 compatible OpenAI : 400 sur `temperature` et `top_p`). */
export interface SamplingSupport {
  temperature: boolean;
  top_p: boolean;
}

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
  /** Mesuré par la sonde. Absent (profil antérieur à la mesure, ou saisi à la main) : supposé accepté, comme avant. */
  sampling?: SamplingSupport;
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

/**
 * Schéma de la sonde json_schema, avec CONTRÔLE NÉGATIF. Ni le nom du champ ni la valeur ne figurent dans le prompt, et le
 * prompt exige explicitement une autre forme (`{"n":2}`), contraire au schéma (`additionalProperties: false`). Une couche qui
 * met le schéma dans le contexte sans l'imposer au décodage (Anthropic compatible OpenAI : 223 jetons de prompt pour une
 * phrase, le schéma y est injecté) peut lire la valeur dans le schéma : sans consigne contraire, elle passerait la sonde. Avec
 * la consigne, un modèle qui obéit au prompt rend `{"n":2}` ; seul un décodage contraint rend `{"probe_token":"zq7"}`.
 * La garantie reste empirique (un modèle pourrait préférer le schéma à la consigne) : l'Ajv final (INV1) et les réparations
 * bornent le risque d'un json_schema conclu à tort.
 */
const PROBE_TOKEN = { field: 'probe_token', value: 'zq7' } as const;
const PROBE_SCHEMA = {
  type: 'object',
  properties: { [PROBE_TOKEN.field]: { type: 'string', enum: [PROBE_TOKEN.value] } },
  required: [PROBE_TOKEN.field],
  additionalProperties: false,
};

/** Consigne contraire au schéma (contrôle négatif) : la forme demandée n'a aucun champ du schéma. */
const PROBE_JSON_PROMPT = 'Reply with exactly this JSON object and nothing else: {"n":2}';

/** Sonde de sampling : 16 jetons suffisent, un modèle à raisonnement tronqué a quand même accepté le paramètre. */
export const SAMPLING_PROBE_MAX_TOKENS = 16;

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
    return typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)[PROBE_TOKEN.field] === PROBE_TOKEN.value;
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

  /** Un paramètre par appel : seul un 400 (`bad_request`) dit « non supporté » ; succès, troncature ou réponse vide : accepté. */
  const probeSamplingParam = async (param: keyof SamplingSupport, value: number): Promise<boolean> => {
    try {
      const result = await transport.chat({ model, messages: [{ role: 'user', content: 'Say ok.' }], stream: false, max_tokens: SAMPLING_PROBE_MAX_TOKENS, [param]: value });
      observe(result);
      return true;
    } catch (error) {
      if (!(error instanceof LlmError)) throw error;
      if (INCONCLUSIVE.has(error.policyClass)) throw error;
      if (error.partial !== undefined) observe(error.partial);
      else if (error.usage !== null) tokens += (error.usage.prompt_tokens ?? 0) + (error.usage.completion_tokens ?? 0);
      if (error.class !== 'bad_request') return true;
      notes.push(`sampling: ${param} refusé (${error.class})`);
      return false;
    }
  };
  const probeSampling = async (): Promise<SamplingSupport> => ({ temperature: await probeSamplingParam('temperature', 0), top_p: await probeSamplingParam('top_p', 0.9) });

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
    messages: [{ role: 'user', content: PROBE_JSON_PROMPT }],
    response_format: { type: 'json_schema', json_schema: { name: 'probe', strict: true, schema: PROBE_SCHEMA } },
  });
  const jsonSchema = two.result !== undefined && jsonSchemaWorks(two.result);
  if (two.result !== undefined && !jsonSchema) notes.push('json_schema: accepté mais non imposé (réponse hors schéma, prose)');

  const three = await attempt('tool_forced', {
    model,
    messages: [{ role: 'user', content: 'Call the function ping with n=3.' }],
    tools: [PING],
    tool_choice: { type: 'function', function: { name: 'ping' } },
  });
  const forced = three.result !== undefined && toolCallWorks(three.result);

  const sampling = await probeSampling();

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
    sampling,
    probed_at: now().toISOString(),
    probe_tokens: tokens,
    notes,
  };
}

/**
 * Requête débarrassée des paramètres d'échantillonnage que le profil déclare refusés (point unique pour tous les appelants :
 * LlmClient, moteur Stagehand). Profil absent ou sans mesure : requête inchangée. `dropped` liste ce qui a été retiré.
 */
export function withoutUnsupportedSampling<T extends object>(profile: CapabilityProfile | undefined, request: T): { request: T; dropped: (keyof SamplingSupport)[] } {
  const sampling = profile?.sampling;
  if (sampling === undefined) return { request, dropped: [] };
  const dropped: (keyof SamplingSupport)[] = [];
  const next = { ...request } as T & { temperature?: number; top_p?: number };
  for (const param of ['temperature', 'top_p'] as const) {
    if (!sampling[param] && next[param] !== undefined) {
      delete next[param];
      dropped.push(param);
    }
  }
  return dropped.length === 0 ? { request, dropped } : { request: next, dropped };
}

/**
 * Paramètres d'échantillonnage ENVOYÉS que nomme le message d'un 400 (`\`temperature\` is deprecated for this model.`).
 * Repli quand le profil n'a pas de mesure (`sampling` absent, sonde jamais lancée) : l'appelant réessaie une fois sans eux.
 */
export function samplingParamsRejected(message: string, sent: { temperature?: unknown; top_p?: unknown }): (keyof SamplingSupport)[] {
  const out: (keyof SamplingSupport)[] = [];
  if (sent.temperature !== undefined && /\btemperature\b/i.test(message)) out.push('temperature');
  if (sent.top_p !== undefined && /\btop[_ ]?p\b/i.test(message)) out.push('top_p');
  return out;
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
