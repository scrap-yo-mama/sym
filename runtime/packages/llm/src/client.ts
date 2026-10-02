// SPDX-License-Identifier: AGPL-3.0-only
// LlmClient : providers[], un modèle par rôle, réessais par classe, repli restreint, échelle S1-S4, comptage (08 §1).
import type { Secret } from '@runtime/core';
import { backoffDelay, DEFAULT_BACKOFF, isFallbackEligible, LlmError, RETRY_LIMITS, type Backoff } from './errors.js';
import { resolveToolChoice, roleProblems, samplingParamsRejected, withoutUnsupportedSampling, type CapabilityProfile, type LlmRole, type SamplingSupport } from './profile.js';
import { createRedactor, type RedactConfig, type Redactor } from './redact.js';
import { compileOriginal, extractJson, toTransportSchema, validateOriginal, wrapRoot, WRAP_KEY } from './schema.js';
import { OpenAICompatTransport, DEFAULT_MAX_REQUEST_BYTES } from './transport.js';
import { charsOf, computeUsage, UsageMeter, type CallUsage, type ModelPrice, type RunUsage } from './usage.js';
import type { CallOptions, ChatMessage, ChatRequest, ChatResult, JsonSchema, LlmTransport, ToolChoice, ToolDef } from './types.js';

export interface ModelConfig {
  id: string;
  price?: ModelPrice;
  profile?: CapabilityProfile;
  maxTokens?: number;
}

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey: Secret;
  headers?: Record<string, Secret | string>;
  timeoutMs?: number;
  /** Corps statique (ex. OpenRouter `{provider:{require_parameters:true}}`). */
  extraBody?: Record<string, unknown>;
  /** Envoyé en `session_id` (OpenRouter : affinité de cache). */
  sessionId?: string;
  models: ModelConfig[];
}

export interface RoleTarget {
  provider: string;
  model: string;
}

export interface RoleConfig extends RoleTarget {
  /** Facultatif : ne sert que sur `overloaded`, `timeout`, `empty_response`. */
  fallback?: RoleTarget;
  maxTokens?: number;
}

export interface LlmConfig {
  providers: ProviderConfig[];
  roles: Partial<Record<LlmRole, RoleConfig>>;
  redact?: RedactConfig;
  maxRequestBytes?: number;
  backoff?: Backoff;
}

/**
 * Note de journal du client (jamais de contenu de prompt ni de clé). Une seule par fournisseur, modèle et paramètre, pour la durée de vie du client.
 * `dropped` : retiré parce que le profil sondé le refuse. `rejected` : profil sans mesure, le fournisseur a répondu 400 en le nommant ; un
 * nouvel essai sans lui a suivi et il n'est plus envoyé à ce modèle par ce client.
 */
export interface LlmNote {
  event: 'llm_sampling_param_dropped' | 'llm_sampling_param_rejected';
  provider: string;
  model: string;
  param: keyof SamplingSupport;
}

export interface ClientHooks {
  /** Reçoit les notes de journal (ex. paramètre d'échantillonnage retiré parce que le profil du modèle le refuse). */
  note?: (note: LlmNote) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  /** Remplace la création des transports (tests). */
  transportFor?: (provider: ProviderConfig) => LlmTransport;
  fetch?: typeof fetch;
}

export interface AttemptRecord {
  provider: string;
  model: string;
  /** Classe de l'échec ; null si l'essai a réussi. */
  failure_class: string | null;
  status: number | undefined;
  duration_ms: number;
  usage: CallUsage | null;
  backoff_ms: number;
}

export interface LlmCallResult {
  result: ChatResult;
  usage: CallUsage;
  attempts: AttemptRecord[];
  fallback_used: boolean;
  provider: string;
  model: string;
}

export interface ChatCall {
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** Intention ; la forme réellement envoyée dépend du profil (jamais forcé si non confirmé). */
  toolChoice?: 'auto' | 'required' | { name: string };
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  signal?: AbortSignal;
  /** Sait tronquer l'entrée : autorise 1 essai après `context_length`. */
  shrinkInput?: (messages: ChatMessage[]) => ChatMessage[] | null;
  /**
   * Garde appelée avant CHAQUE envoi (premier essai, réessai, réparation, repli) : une exception l'empêche et remonte
   * telle quelle, sans réessai ni repli (plafond de coût de l'essai, tâche 2.4).
   */
  beforeCall?: () => void;
}

export type StructuredLevel = 'S1' | 'S2' | 'S3' | 'S4';

export interface StructuredCall {
  messages: ChatMessage[];
  schema: JsonSchema;
  name?: string;
  /** Force un niveau (sinon choisi d'après le profil). */
  level?: StructuredLevel;
  /** Réparations après une sortie hors schéma (défaut 2). */
  maxRepairs?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Voir `ChatCall.beforeCall`. */
  beforeCall?: () => void;
  /**
   * Aucun outil dans la requête, même l'outil de soumission de S2 (E4, `judge`, `reflect` : phases sans outil, 19 §7,
   * `assert_e4_no_tools`) : S2 descend en S3 si le profil le permet, sinon en S4.
   */
  noTools?: boolean;
}

export interface StructuredResult<T = unknown> {
  value: T;
  level: StructuredLevel;
  repairs: number;
  calls: LlmCallResult[];
}

const SUBMIT_TOOL = 'submit_result';

export function pickLevel(profile: CapabilityProfile | undefined): StructuredLevel {
  if (profile === undefined) return 'S4';
  if (profile.structured_modes.includes('json_schema')) return 'S1';
  if (profile.structured_modes.includes('tool_forced') && profile.tool_choice.includes('named')) return 'S2';
  if (profile.structured_modes.includes('json_object')) return 'S3';
  return 'S4';
}

export class LlmClient {
  readonly meter = new UsageMeter();
  readonly #config: LlmConfig;
  readonly #hooks: Required<Pick<ClientHooks, 'sleep' | 'random' | 'now'>> & ClientHooks;
  readonly #transports = new Map<string, LlmTransport>();
  readonly #redactor: Redactor | undefined;
  readonly #noted = new Set<string>();
  /** `fournisseur/modèle/paramètre` refusés en 400 alors que le profil ne le disait pas : plus jamais envoyés par ce client. */
  readonly #rejected = new Set<string>();

  constructor(config: LlmConfig, hooks: ClientHooks = {}) {
    this.#config = config;
    this.#hooks = {
      sleep: hooks.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      random: hooks.random ?? Math.random,
      now: hooks.now ?? (() => new Date()),
      ...hooks,
    };
    this.#redactor = config.redact === undefined ? undefined : createRedactor(config.redact);
    for (const [role, target] of Object.entries(config.roles) as [LlmRole, RoleConfig][]) {
      const { model } = this.#resolve(target);
      const problems = roleProblems(role, model.profile);
      if (problems.length > 0) throw new LlmError('bad_request', `rôle ${role} refusé : ${problems.join(' ; ')}`, { code: 'role_profile' });
      if (target.fallback !== undefined) this.#resolve(target.fallback);
    }
  }

  #resolve(target: RoleTarget): { provider: ProviderConfig; model: ModelConfig } {
    const provider = this.#config.providers.find((p) => p.id === target.provider);
    const model = provider?.models.find((m) => m.id === target.model);
    if (provider === undefined || model === undefined) {
      throw new LlmError('bad_request', `fournisseur ou modèle inconnu : ${target.provider}/${target.model}`, { code: 'unknown_target' });
    }
    return { provider, model };
  }

  #transport(provider: ProviderConfig): LlmTransport {
    let t = this.#transports.get(provider.id);
    if (t === undefined) {
      t =
        this.#hooks.transportFor?.(provider) ??
        new OpenAICompatTransport({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          ...(provider.headers !== undefined ? { headers: provider.headers } : {}),
          ...(provider.timeoutMs !== undefined ? { timeoutMs: provider.timeoutMs } : {}),
          maxRequestBytes: this.#config.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
          ...(provider.extraBody !== undefined ? { extraBody: provider.extraBody } : {}),
          ...(this.#hooks.fetch !== undefined ? { fetch: this.#hooks.fetch } : {}),
        });
      this.#transports.set(provider.id, t);
    }
    return t;
  }

  roleTarget(role: LlmRole): RoleConfig {
    const target = this.#config.roles[role];
    if (target === undefined) throw new LlmError('bad_request', `rôle non configuré : ${role}`, { code: 'role_unset' });
    return target;
  }

  profileOf(role: LlmRole): CapabilityProfile | undefined {
    return this.#resolve(this.roleTarget(role)).model.profile;
  }

  /** Un seul message `system`, en tête (08 §1). */
  static assertMessages(messages: ChatMessage[]): void {
    const systems = messages.map((m, i) => (m.role === 'system' ? i : -1)).filter((i) => i >= 0);
    if (systems.length > 1 || (systems.length === 1 && systems[0] !== 0)) {
      throw new LlmError('bad_request', 'un seul message system est permis, et en tête', { code: 'system_position' });
    }
  }

  /** Appel brut d'un rôle : masquage, réessais par classe, repli restreint, comptage. */
  async call(role: LlmRole, req: Omit<ChatRequest, 'model'>, options: Pick<ChatCall, 'signal' | 'shrinkInput' | 'beforeCall'> = {}): Promise<LlmCallResult> {
    const target = this.roleTarget(role);
    LlmClient.assertMessages(req.messages);
    const attempts: AttemptRecord[] = [];
    const targets: { t: RoleTarget; isFallback: boolean }[] = [{ t: target, isFallback: false }];
    if (target.fallback !== undefined) targets.push({ t: target.fallback, isFallback: true });

    let lastError: LlmError | undefined;
    for (const { t, isFallback } of targets) {
      try {
        const done = await this.#withRetries(t, req, options, attempts);
        return { ...done, attempts, fallback_used: isFallback };
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        lastError = error;
        if (isFallback || !isFallbackEligible(error)) break;
      }
    }
    throw lastError ?? new LlmError('network', 'aucune cible');
  }

  async #withRetries(
    target: RoleTarget,
    req: Omit<ChatRequest, 'model'>,
    options: Pick<ChatCall, 'signal' | 'shrinkInput' | 'beforeCall'>,
    attempts: AttemptRecord[],
  ): Promise<{ result: ChatResult; usage: CallUsage; provider: string; model: string }> {
    const { provider, model } = this.#resolve(target);
    const transport = this.#transport(provider);
    const backoff = this.#config.backoff ?? DEFAULT_BACKOFF;
    let messages = req.messages;
    let shrunk = false;
    const retries = new Map<string, number>();
    for (;;) {
      const outgoing = this.#redactor === undefined ? messages : this.#redactor.messages(messages);
      const request: ChatRequest = {
        ...req,
        model: model.id,
        messages: outgoing,
        ...(req.max_tokens === undefined && model.maxTokens !== undefined ? { max_tokens: model.maxTokens } : {}),
        extraBody: {
          ...(provider.sessionId !== undefined ? { session_id: provider.sessionId } : {}),
          ...req.extraBody,
        },
      };
      // Paramètres d'échantillonnage refusés par le profil de CETTE cible (le repli a le sien) : retirés, notés une fois.
      const { request: profiled, dropped } = withoutUnsupportedSampling(model.profile, request);
      for (const param of dropped) this.#noteDropped(provider.id, model.id, param);
      const sent = this.#withoutRejected(provider.id, model.id, profiled);
      // Hors du try : une garde qui refuse n'est ni une erreur du fournisseur, ni réessayée.
      options.beforeCall?.();
      const started = Date.now();
      const callOptions: CallOptions = options.signal === undefined ? {} : { signal: options.signal };
      try {
        const result = await transport.chat(sent, callOptions);
        const usage = this.#account(model, result.usage, sent, charsOfResult(result));
        attempts.push({ provider: provider.id, model: model.id, failure_class: null, status: 200, duration_ms: result.duration_ms, usage, backoff_ms: 0 });
        return { result, usage, provider: provider.id, model: model.id };
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        // Tentative échouée mais facturée (troncature, flux coupé) : imputée au run.
        const usage = error.usage === null ? null : this.#account(model, error.usage, sent, 0);
        const cls = error.policyClass;

        // Repli (profil sans mesure de `sampling`, ex. production avant la route de sonde) : un 400 qui nomme un paramètre
        // d'échantillonnage envoyé => un nouvel essai sans lui, une seule fois par paramètre, noté.
        const rejected = error.class === 'bad_request' ? samplingParamsRejected(error.message, sent).filter((p) => !this.#rejected.has(`${provider.id}/${model.id}/${p}`)) : [];
        if (rejected.length > 0) {
          for (const param of rejected) {
            this.#rejected.add(`${provider.id}/${model.id}/${param}`);
            this.#hooks.note?.({ event: 'llm_sampling_param_rejected', provider: provider.id, model: model.id, param });
          }
          attempts.push({ provider: provider.id, model: model.id, failure_class: error.failureClass, status: error.status, duration_ms: Date.now() - started, usage, backoff_ms: 0 });
          continue;
        }

        if (error.class === 'context_length' && options.shrinkInput !== undefined && !shrunk) {
          const next = options.shrinkInput(messages);
          if (next !== null) {
            shrunk = true;
            messages = next;
            attempts.push({ provider: provider.id, model: model.id, failure_class: error.failureClass, status: error.status, duration_ms: Date.now() - started, usage, backoff_ms: 0 });
            continue;
          }
        }
        const used = retries.get(cls) ?? 0;
        let wait = 0;
        const retry = used < RETRY_LIMITS[cls];
        if (retry) {
          wait = backoffDelay(used, error.retryAfterMs, this.#hooks.random, backoff);
          retries.set(cls, used + 1);
        }
        attempts.push({ provider: provider.id, model: model.id, failure_class: error.failureClass, status: error.status, duration_ms: Date.now() - started, usage, backoff_ms: wait });
        if (!retry) throw error;
        await this.#hooks.sleep(wait);
      }
    }
  }

  #withoutRejected(provider: string, model: string, request: ChatRequest): ChatRequest {
    const drop = (['temperature', 'top_p'] as const).filter((p) => request[p] !== undefined && this.#rejected.has(`${provider}/${model}/${p}`));
    if (drop.length === 0) return request;
    const next = { ...request };
    for (const p of drop) delete next[p];
    return next;
  }

  #noteDropped(provider: string, model: string, param: keyof SamplingSupport): void {
    const key = `${provider}/${model}/${param}`;
    if (this.#noted.has(key)) return;
    this.#noted.add(key);
    this.#hooks.note?.({ event: 'llm_sampling_param_dropped', provider, model, param });
  }

  #account(model: ModelConfig, raw: ChatResult['usage'], request: ChatRequest, responseChars: number): CallUsage {
    const usage = computeUsage({ raw, price: model.price, requestChars: charsOf(request.messages), responseChars, at: this.#hooks.now() });
    this.meter.add(usage);
    return usage;
  }

  /** Appel conversationnel d'un rôle (boucle d'outils gérée par l'appelant : `maxSteps` et plafond de coût). */
  async chat(role: LlmRole, call: ChatCall): Promise<LlmCallResult> {
    const profile = this.profileOf(role);
    const choice: ToolChoice | undefined =
      call.toolChoice === undefined ? undefined : resolveToolChoice(profile, call.toolChoice);
    return this.call(
      role,
      {
        messages: call.messages,
        ...(call.tools !== undefined ? { tools: call.tools } : {}),
        ...(choice !== undefined ? { tool_choice: choice } : {}),
        ...(call.maxTokens !== undefined ? { max_tokens: call.maxTokens } : {}),
        ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
        ...(call.topP !== undefined ? { top_p: call.topP } : {}),
      },
      {
        ...(call.signal !== undefined ? { signal: call.signal } : {}),
        ...(call.shrinkInput !== undefined ? { shrinkInput: call.shrinkInput } : {}),
        ...(call.beforeCall !== undefined ? { beforeCall: call.beforeCall } : {}),
      },
    );
  }

  /**
   * Sortie structurée par l'échelle S1-S4, puis validation Ajv FINALE contre le schéma d'origine (INV1) avec au plus
   * `maxRepairs` réparations. Hors schéma : `schema_invalid`, jamais un succès.
   */
  async generateStructured<T = unknown>(role: LlmRole, call: StructuredCall): Promise<StructuredResult<T>> {
    compileOriginal(typeof call.schema === 'boolean' ? {} : call.schema); // refuse tôt un schéma invalide ou un $ref distant
    const picked = call.level ?? pickLevel(this.profileOf(role));
    const level: StructuredLevel = call.noTools === true && picked === 'S2' ? (this.profileOf(role)?.structured_modes.includes('json_object') === true ? 'S3' : 'S4') : picked;
    const name = (call.name ?? 'output').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'output';
    const transportSchema = toTransportSchema(call.schema);
    const { schema: rootSchema, wrapped } = wrapRoot(transportSchema);
    const maxRepairs = call.maxRepairs ?? 2;

    let messages = withSchemaPrompt(call.messages, level, rootSchema);
    const calls: LlmCallResult[] = [];
    let lastErrors: string[] = [];

    for (let repairs = 0; repairs <= maxRepairs; repairs += 1) {
      const req: Omit<ChatRequest, 'model'> = { messages };
      if (level === 'S1') req.response_format = { type: 'json_schema', json_schema: { name, strict: true, schema: rootSchema } };
      if (level === 'S2') {
        req.tools = [{ type: 'function', function: { name: SUBMIT_TOOL, description: 'Submit the final structured result.', parameters: rootSchema, strict: true } }];
        req.tool_choice = { type: 'function', function: { name: SUBMIT_TOOL } };
      }
      if (level === 'S3') req.response_format = { type: 'json_object' };
      if (call.maxTokens !== undefined) req.max_tokens = call.maxTokens;

      const done = await this.call(role, req, {
        ...(call.signal === undefined ? {} : { signal: call.signal }),
        ...(call.beforeCall === undefined ? {} : { beforeCall: call.beforeCall }),
      });
      calls.push(done);
      const message = done.result.message;

      let candidate: unknown;
      let parseError: string | undefined;
      try {
        candidate = this.#candidate(level, message);
        if (wrapped) candidate = unwrap(candidate);
      } catch (error) {
        parseError = error instanceof Error ? error.message : 'sortie illisible';
      }
      if (parseError === undefined) {
        const verdict = validateOriginal(call.schema, candidate);
        if (verdict.ok) return { value: verdict.value as T, level, repairs, calls };
        lastErrors = verdict.errors;
      } else lastErrors = [parseError];

      if (repairs === maxRepairs) break;
      messages = [...messages, ...repairMessages(level, message, lastErrors)];
    }
    throw new LlmError('schema_invalid', `sortie hors schéma après ${maxRepairs} réparation(s) : ${lastErrors.slice(0, 3).join(' ; ')}`, { code: 'schema_invalid' });
  }

  #candidate(level: StructuredLevel, message: ChatMessage): unknown {
    const text = typeof message.content === 'string' ? message.content : '';
    if (level === 'S2') {
      const call = message.tool_calls?.find((c) => c.function.name === SUBMIT_TOOL);
      if (call !== undefined) return JSON.parse(call.function.arguments);
      return extractJson(text); // certains modèles répondent en texte malgré l'outil forcé
    }
    if (level === 'S1') return JSON.parse(text.trim());
    return extractJson(text);
  }

  usage(): RunUsage {
    return this.meter.snapshot();
  }
}

function charsOfResult(result: ChatResult): number {
  return charsOf([result.message]);
}

function unwrap(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && WRAP_KEY in value) return (value as Record<string, unknown>)[WRAP_KEY];
  throw new Error(`enveloppe « ${WRAP_KEY} » absente`);
}

/** S3 et S4 : le schéma va dans le message `system` de tête (préfixe stable, cacheable). */
function withSchemaPrompt(messages: ChatMessage[], level: StructuredLevel, schema: JsonSchema): ChatMessage[] {
  if (level === 'S1' || level === 'S2') return messages;
  const instruction =
    `Respond with a single JSON value that conforms to this JSON Schema, and nothing else:\n${JSON.stringify(schema)}`;
  const [first, ...rest] = messages;
  if (first?.role === 'system' && typeof first.content === 'string') return [{ ...first, content: `${first.content}\n\n${instruction}` }, ...rest];
  return [{ role: 'system', content: instruction }, ...messages];
}

function repairMessages(level: StructuredLevel, bad: ChatMessage, errors: string[]): ChatMessage[] {
  const note = `Your output was invalid: ${errors.join('; ')}. Return a corrected result that conforms to the schema.`;
  if (level === 'S2' && bad.tool_calls !== undefined && bad.tool_calls.length > 0) {
    return [
      bad,
      ...bad.tool_calls.map((c, i): ChatMessage => ({ role: 'tool', tool_call_id: c.id, content: i === 0 ? note : 'ignored' })),
    ];
  }
  return [bad, { role: 'user', content: note }];
}

export function createLlmClient(config: LlmConfig, hooks?: ClientHooks): LlmClient {
  return new LlmClient(config, hooks);
}
