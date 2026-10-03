// SPDX-License-Identifier: AGPL-3.0-only
// Moteur agentique serveur retenu par l'ADR 0001 : Stagehand 3.7.3 `agent()`, mode `dom`, derrière `AgentEngine`.
// Repris du bras B du spike (eval/spike), avec les obligations de l'intégration (tâche 2.4) :
// - local seulement (`assertStagehandLocalOnly`, X1) et outils en liste FERMÉE (`STAGEHAND_TOOL_ACTIONS`, 08 §4
//   mesure 3), contrôlés à chaque appel du modèle : un outil hors liste arrête le run avant l'appel ;
// - Chromium fourni par l'appelant (`cdpUrl`) : proxy d'egress de l'essai (verrou de domaines et garde SSRF à chaque
//   saut), route Playwright en seconde couche ; Stagehand n'ouvre aucun navigateur et ne passe jamais par le tunnel
//   (`agentStepCompatible: false`, E6 limité au serveur, 0.6b) ;
// - plafonds d'étapes, de durée et de coût (`run_budget_exceeded`), température transmise par middleware ; le coût est
//   contrôlé AVANT et après chaque appel, avec la dépense de l'essai faite ailleurs (proxy, autres appels) ; un appel non
//   tarifé (prix absent) rend le plafond intenable : arrêt, coût null (jamais 0, 08 §1). Le coût se lit dans l'usage BRUT
//   de la réponse, avec les règles du LlmClient (`computeUsage`) : `usage.cost` (OpenRouter) fait foi, puis le prix
//   configuré, puis `usage.estimated_cost` (DeepInfra) ; jetons absents : estimés d'après la taille de la requête envoyée
//   et de la réponse (jamais 0, signalés `usageEstimated`) ;
// - prompts nettoyés dans le middleware, hors du LlmClient (stagehand-prompt.ts) : masquage `llm.redact` et jetons
//   d'URL retirés, sur tout ce qui part au fournisseur (08 §1, 08 §4 mesure 5) ;
// - garde de l'appelant attendue avant chaque appel (`beforeModelCall`) : classification des documents de la page en
//   cours (défi servi en 200 compris) ; un refus arrête le run SANS appel (INV6) ;
// - trace : une étape par outil d'action, avec la cible sémantique (rôle + nom accessible) des clics, lue par
//   l'enregistreur (semantic-recorder.ts) : base de la compilation E6 → E5. Aucun contenu de page dans la trace.
// Le contenu des pages reste une donnée non fiable : la consigne de l'utilisateur est la seule instruction ; Stagehand
// garde son prompt système (mesuré tel quel au spike), auquel s'ajoutent les règles Markdown (tâche 2.10, 18 §4.5) :
// `systemPrompt` = <trusted_rules> et liste des skills (inséré par Stagehand dans <customInstructions>), `tools` =
// { read_skill } exécuté dans notre processus, `integrations` (clients MCP) TOUJOURS vide en V1 (18 §5).
import { Stagehand, type ModelConfiguration } from '@browserbasehq/stagehand';
import { READ_SKILL_TOOL, type AgentEngine, type AgentRunContext, type AgentRunResult, type AgentRunStatus, type AgentTask, type AgentTraceStep } from '@runtime/core';
import { computeUsage, createRedactor, type CapabilityProfile, type ModelPrice, type RawUsage, type RedactConfig } from '@runtime/llm';
import { z } from 'zod';
import type { SemanticClick, SemanticRecorder } from './semantic-recorder.js';
import { AgentToolsetNotClosedError, assertStagehandLocalOnly, STAGEHAND_EXCLUDED_TOOLS, toolsOutsideClosedList } from './stagehand-guards.js';
import { sanitizeModelPrompt } from './stagehand-prompt.js';
import { adaptSampling, generateWithSamplingRetry } from './stagehand-sampling.js';

export const STAGEHAND_VERSION = '3.7.3';

type Middleware = NonNullable<Extract<ModelConfiguration, { modelName: unknown }>['middleware']>;

/**
 * Options du constructeur Stagehand (pures, testées par `assert_stagehand_selfheal_off`, tâche 2.13, 19 §4) : mode local
 * seulement (X1), `selfHeal: false` EXPLICITE (défaut de 3.7.3 : vrai) et AUCUN `cacheDir` : ni reprise silencieuse d'une
 * action par Stagehand, ni cache d'actions rejouées hors de notre compilation E6 → E5 (la reprise est celle de 19 §4).
 */
export function stagehandConstructorOptions(args: { modelId: string; baseURL: string; apiKey: string; cdpUrl: string; middleware: Middleware }): ConstructorParameters<typeof Stagehand>[0] {
  return {
    env: 'LOCAL',
    model: {
      modelName: `openai/${args.modelId}`,
      baseURL: args.baseURL,
      apiKey: args.apiKey,
      openaiEndpointFormat: 'chat',
      middleware: args.middleware,
    } as ModelConfiguration,
    localBrowserLaunchOptions: { cdpUrl: args.cdpUrl },
    disableAPI: true,
    // Exigé par Stagehand 3.7.3 pour `output`, `excludeTools`, `signal` et les rappels d'agent.
    experimental: true,
    disablePino: true,
    verbose: 0,
    logger: () => undefined,
    selfHeal: false,
  };
}

/**
 * Un appel LLM vu par le middleware : usage brut du fournisseur (coût), tailles de la requête et de la réponse (estimation
 * des jetons quand l'usage manque) et noms d'outils appelés (jamais leurs arguments ni le prompt).
 */
export interface StagehandLlmCall {
  readonly temperatureSent: number | undefined;
  readonly usage: RawUsage | null;
  readonly requestChars: number;
  readonly responseChars: number;
  readonly toolNames: readonly string[];
}

/** Points d'accroche de l'exécuteur de l'essai (plafond de coût partagé, garde de classification). */
export interface StagehandEngineHooks {
  /**
   * Dépense de l'essai faite hors de ce run depuis son début (proxy, autres appels LLM) ; null : inconnue. Le run s'arrête
   * quand son coût plus cette dépense atteint `task.limits.maxCostUsd`.
   */
  readonly spentElsewhereUsd?: () => number | null;
  /** Coût cumulé du run après chaque appel au modèle (null : non tarifé). */
  readonly onCost?: (usd: number | null) => void;
  /** Attendu avant chaque appel au modèle ; rejeter arrête le run sans appel (page refusée, INV6). */
  readonly beforeModelCall?: () => Promise<void>;
}

export interface StagehandEngineOptions extends StagehandEngineHooks {
  /** Point CDP du Chromium dédié à l'essai (ouvert par l'appelant, derrière le proxy d'egress). */
  readonly cdpUrl: string;
  readonly baseURL: string;
  /** Clé du fournisseur du rôle `agent` : lue au moment du run, jamais journalisée (INV8). */
  readonly apiKey: () => string;
  readonly price: ModelPrice | undefined;
  /** Enregistreur posé par l'appelant sur le contexte du navigateur (compilation E6 → E5). */
  readonly recorder?: SemanticRecorder;
  readonly onLlmCall?: (call: StagehandLlmCall) => void;
  /** Environnement contrôlé par `assertStagehandLocalOnly` (défaut : celui du processus). */
  readonly env?: NodeJS.ProcessEnv;
  /** `llm.redact` des réglages (même règle que le LlmClient : absent, aucun masquage). */
  readonly redact?: RedactConfig;
  /** Profil sondé du modèle : un paramètre d'échantillonnage qu'il refuse (`profile.sampling`) n'est jamais envoyé (même règle que le LlmClient). */
  readonly profile?: CapabilityProfile;
  /** Appelé une seule fois par run et par paramètre retiré (note de journal ; ni prompt ni clé). */
  readonly onSamplingDropped?: (param: 'temperature' | 'top_p') => void;
  /** Profil sans mesure : le fournisseur a répondu 400 en nommant le paramètre, un nouvel essai sans lui a suivi (une fois par run et par paramètre). */
  readonly onSamplingRejected?: (param: 'temperature' | 'top_p') => void;
}

/** JSON Schema (sous-ensemble) vers Zod : `execute({ output })` attend un objet Zod. Ajv revalide hors du moteur (INV1). */
export function jsonSchemaToZod(schema: Readonly<Record<string, unknown>>): z.ZodType {
  const type = schema['type'];
  if (type === undefined) return z.any();
  if (Array.isArray(type)) {
    const variants = type.map((t) => jsonSchemaToZod({ ...schema, type: t }));
    const [a, b, ...rest] = variants;
    if (a === undefined) throw new Error('type vide');
    return b === undefined ? a : z.union([a, b, ...rest]);
  }
  switch (type) {
    case 'string':
      return Array.isArray(schema['enum']) ? z.enum(schema['enum'] as [string, ...string[]]) : z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array':
      return z.array(jsonSchemaToZod((schema['items'] ?? {}) as Record<string, unknown>));
    case 'object': {
      const properties = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
      const required = new Set((schema['required'] ?? []) as string[]);
      const shape: Record<string, z.ZodType> = {};
      for (const [key, child] of Object.entries(properties)) {
        const inner = jsonSchemaToZod(child);
        shape[key] = required.has(key) ? inner : inner.optional();
      }
      return schema['additionalProperties'] === false ? z.strictObject(shape) : z.object(shape);
    }
    default:
      throw new Error(`type JSON Schema non géré : ${String(type)}`);
  }
}

interface V2Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const jsonLength = (v: unknown): number => {
  try {
    return typeof v === 'string' ? v.length : (JSON.stringify(v) ?? '').length;
  } catch {
    return 0;
  }
};

/**
 * Usage brut d'une réponse de l'AI SDK : l'objet `usage` du corps renvoyé par le fournisseur (`cost`, `estimated_cost`,
 * jetons et détails), complété par les jetons que l'AI SDK a lus s'ils manquent au corps. Null : aucun usage.
 */
function rawUsageOf(responseBody: unknown, sdkUsage: V2Usage | undefined): RawUsage | null {
  const body = isRecord(responseBody) && isRecord(responseBody['usage']) ? (responseBody['usage'] as RawUsage) : null;
  const u = sdkUsage ?? {};
  const fromSdk: RawUsage = {
    ...(u.inputTokens !== undefined ? { prompt_tokens: u.inputTokens } : {}),
    ...(u.outputTokens !== undefined ? { completion_tokens: u.outputTokens } : {}),
    ...(u.cachedInputTokens !== undefined ? { prompt_tokens_details: { cached_tokens: u.cachedInputTokens } } : {}),
    ...(u.reasoningTokens !== undefined ? { completion_tokens_details: { reasoning_tokens: u.reasoningTokens } } : {}),
  };
  if (body === null) return Object.keys(fromSdk).length === 0 ? null : fromSdk;
  return {
    ...fromSdk,
    ...body,
    ...(typeof body.prompt_tokens === 'number' || fromSdk.prompt_tokens === undefined ? {} : { prompt_tokens: fromSdk.prompt_tokens }),
    ...(typeof body.completion_tokens === 'number' || fromSdk.completion_tokens === undefined ? {} : { completion_tokens: fromSdk.completion_tokens }),
    ...(isRecord(body.prompt_tokens_details) || fromSdk.prompt_tokens_details === undefined ? {} : { prompt_tokens_details: fromSdk.prompt_tokens_details }),
    ...(isRecord(body.completion_tokens_details) || fromSdk.completion_tokens_details === undefined ? {} : { completion_tokens_details: fromSdk.completion_tokens_details }),
  };
}

/** Caractères de la réponse du modèle (texte et appels d'outils) : base de l'estimation des jetons de sortie. */
function responseCharsOf(content: readonly unknown[]): number {
  let total = 0;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (typeof part['text'] === 'string') total += part['text'].length;
    if (part['type'] === 'tool-call') total += jsonLength(part['input']) + jsonLength(part['toolName']);
  }
  return total;
}

/** Action d'agent telle que la rend Stagehand 3.7.3 (`AgentResult.actions`). */
type StagehandAction = { type: string; url?: unknown; pageUrl?: unknown; timestamp?: unknown; playwrightArguments?: unknown; [key: string]: unknown };

const CLICK_METHODS = new Set(['click', 'doubleClick', 'dblclick', 'clickAndHold']);
const TYPE_METHODS = new Set(['fill', 'type', 'press', 'selectOption', 'selectOptionFromDropdown', 'check', 'uncheck']);
const SCROLL_METHODS = new Set(['scroll', 'scrollTo', 'scrollIntoView', 'nextChunk', 'prevChunk', 'mouse.wheel']);

/**
 * Trace de l'agent : une étape par outil d'action. Un clic reçoit la cible sémantique du DERNIER clic réel enregistré
 * entre l'action précédente et la sienne ; sans clic réel enregistré, pas de cible (la compilation échouera).
 */
export function stagehandTrace(actions: readonly StagehandAction[], clicks: readonly SemanticClick[]): AgentTraceStep[] {
  const steps: AgentTraceStep[] = [];
  let previousAt = Number.NEGATIVE_INFINITY;
  for (const action of actions) {
    const at = typeof action.timestamp === 'number' ? action.timestamp : Number.POSITIVE_INFINITY;
    const pageUrl = typeof action.pageUrl === 'string' ? action.pageUrl : '';
    const window = clicks.filter((c) => c.at > previousAt && c.at <= at);
    previousAt = at;
    const base = { index: steps.length, durationMs: 0 };
    switch (action.type) {
      case 'done':
        continue;
      case 'goto':
        steps.push({ ...base, action: 'navigate', url: typeof action.url === 'string' ? action.url : '', executed: true });
        break;
      case 'navback':
        // Retour arrière : la cible n'est pas connue ; la compilation le refuse (URL vide).
        steps.push({ ...base, action: 'navigate', url: '', executed: true });
        break;
      case 'act': {
        const args = action.playwrightArguments as { method?: unknown } | undefined;
        const method = typeof args?.method === 'string' ? args.method : '';
        if (args === undefined) {
          steps.push({ ...base, action: 'click', url: pageUrl, executed: false });
        } else if (CLICK_METHODS.has(method)) {
          const click = window.at(-1);
          const target = click !== undefined && click.role !== '' && click.name !== '' ? { semanticTarget: { role: click.role, name: click.name } } : {};
          steps.push({ ...base, action: 'click', url: pageUrl, executed: true, ...target });
        } else if (SCROLL_METHODS.has(method)) {
          steps.push({ ...base, action: 'scroll', url: pageUrl, executed: true });
        } else {
          steps.push({ ...base, action: TYPE_METHODS.has(method) ? 'type' : 'click', url: pageUrl, executed: true });
        }
        break;
      }
      case 'fillForm':
      case 'keys':
        steps.push({ ...base, action: 'type', url: pageUrl, executed: true });
        break;
      case 'scroll':
        steps.push({ ...base, action: 'scroll', url: pageUrl, executed: true });
        break;
      default:
        steps.push({ ...base, action: 'read', url: pageUrl, executed: true });
    }
  }
  return steps;
}

/** Configuration de `stagehand.agent()` (18 §4.5, assert_stagehand_no_integrations) ; un client MCP fourni est refusé. */
export function stagehandAgentConfig(task: AgentTask): {
  readonly mode: 'dom';
  readonly systemPrompt?: string;
  readonly tools: { readonly read_skill: { readonly description: string; readonly inputSchema: z.ZodType; readonly execute: (args: { name?: unknown }) => Promise<string> } };
  readonly integrations: readonly never[];
} {
  const extra = (task as unknown as { integrations?: unknown }).integrations;
  if (extra !== undefined && !(Array.isArray(extra) && extra.length === 0)) throw new Error('integrations (clients MCP) interdites en V1 (18 §5)');
  const rules = task.rules;
  return {
    mode: 'dom',
    ...(rules === undefined || rules.systemPrompt === '' ? {} : { systemPrompt: rules.systemPrompt }),
    tools: {
      read_skill: {
        description: READ_SKILL_TOOL.description,
        inputSchema: z.object({ name: z.string().max(64) }),
        execute: async (args) => (rules === undefined || typeof args.name !== 'string' ? 'skill_not_found' : rules.readSkill(args.name)),
      },
    },
    integrations: [],
  };
}

export class StagehandEngine implements AgentEngine {
  readonly id = 'stagehand' as const;
  readonly version = STAGEHAND_VERSION;
  readonly capabilities = { agentStepCompatible: false } as const;
  readonly #opts: StagehandEngineOptions;

  constructor(options: StagehandEngineOptions) {
    this.#opts = options;
  }

  async run(task: AgentTask, context: AgentRunContext): Promise<AgentRunResult> {
    if (context.channel !== undefined) throw new Error('un moteur tiers ne passe jamais par le canal agent_step (07 §3)');
    const t0 = performance.now();
    const calls: StagehandLlmCall[] = [];
    const temperature = context.model.temperature;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), task.limits.maxDurationMs);
    const signal = context.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, context.signal]);
    let costExceeded = false;
    const droppedNoted = new Set<string>();
    /** Refusés en 400 pendant ce run (profil sans mesure) : plus envoyés aux appels suivants. */
    const rejectedSampling = new Set<'temperature' | 'top_p'>();
    let pageRefused = false;
    let toolsetViolation: AgentToolsetNotClosedError | undefined;
    const redactor = this.#opts.redact === undefined ? undefined : createRedactor(this.#opts.redact);

    const cost = (): { usd: number | null; usage: AgentRunResult['usage'] } => {
      let known = 0;
      let unpriced = false;
      const u = { tokensIn: 0, tokensCached: 0, tokensOut: 0, tokensReasoning: 0, usageEstimated: false };
      for (const call of calls) {
        const c = computeUsage({ raw: call.usage, price: this.#opts.price, requestChars: call.requestChars, responseChars: call.responseChars });
        u.tokensIn += c.tokens_in;
        u.tokensCached += c.tokens_cached;
        u.tokensOut += c.tokens_out;
        u.tokensReasoning += c.tokens_reasoning;
        u.usageEstimated ||= c.usage_estimated;
        if (c.cost_usd === null) unpriced = true;
        else known += c.cost_usd;
      }
      return { usd: unpriced ? null : known, usage: u };
    };

    /** Plafond de coût : coût du run + dépense ailleurs ; inconnu (non tarifé) = intenable. Vrai si le run doit s'arrêter. */
    const overBudget = (): boolean => {
      const own = cost().usd;
      const elsewhere = this.#opts.spentElsewhereUsd?.() ?? 0;
      return own === null || elsewhere === null || own + elsewhere >= task.limits.maxCostUsd;
    };
    const stopForBudget = (): Error => {
      costExceeded = true;
      const error = new Error('run_budget_exceeded');
      controller.abort(error);
      return error;
    };

    const middleware: Middleware = {
      // Avant CHAQUE appel : garde de l'appelant (page refusée), plafond de coût, liste fermée d'outils (08 §4 mesure 3)
      // contrôlée sur ce que Stagehand propose réellement au modèle, puis prompt nettoyé (masquage, jetons d'URL).
      transformParams: async ({ params }) => {
        if (this.#opts.beforeModelCall !== undefined) {
          try {
            await this.#opts.beforeModelCall();
          } catch (error) {
            pageRefused = true;
            controller.abort(error);
            throw error;
          }
        }
        if (overBudget()) throw stopForBudget();
        const names = (params.tools ?? []).map((t) => t.name);
        const outside = toolsOutsideClosedList(names);
        if (outside.length > 0) {
          toolsetViolation = new AgentToolsetNotClosedError(outside);
          controller.abort(toolsetViolation);
          throw toolsetViolation;
        }
        const prompt = sanitizeModelPrompt(params.prompt, { ...(redactor === undefined ? {} : { redactor }), instruction: task.instruction });
        const sampling = adaptSampling(this.#opts.profile, { temperature, topP: params.topP });
        for (const param of sampling.dropped) {
          if (!droppedNoted.has(param)) {
            droppedNoted.add(param);
            this.#opts.onSamplingDropped?.(param);
          }
        }
        return {
          ...params,
          prompt,
          temperature: rejectedSampling.has('temperature') ? undefined : sampling.temperature,
          topP: rejectedSampling.has('top_p') ? undefined : sampling.topP,
        };
      },
      wrapGenerate: async ({ doGenerate, params: transformed, model }) => {
        // Repli sans profil sondé : 400 qui nomme temperature ou top_p => un nouvel essai sans lui (`model` : le modèle non enveloppé).
        let params = transformed;
        const result = await generateWithSamplingRetry(
          transformed,
          (next) => {
            params = next;
            return next === transformed ? doGenerate() : model.doGenerate(next);
          },
          (param) => {
            rejectedSampling.add(param);
            this.#opts.onSamplingRejected?.(param);
          },
        );
        // Usage BRUT de la réponse (`usage.cost`, `estimated_cost`, jetons) : l'usage normalisé de l'AI SDK perd le coût
        // du fournisseur. Taille de la requête réellement envoyée (corps), à défaut le prompt et les outils.
        const raw = rawUsageOf(result.response?.body, result.usage as V2Usage | undefined);
        const sent = result.request?.body;
        const requestChars = sent !== undefined ? jsonLength(sent) : jsonLength({ prompt: params.prompt, tools: params.tools });
        const toolNames = result.content.filter((part) => part.type === 'tool-call').map((part) => (part as { toolName: string }).toolName);
        const call: StagehandLlmCall = { temperatureSent: params.temperature, usage: raw, requestChars, responseChars: responseCharsOf(result.content), toolNames };
        calls.push(call);
        this.#opts.onLlmCall?.(call);
        this.#opts.onCost?.(cost().usd);
        if (overBudget()) stopForBudget();
        return result;
      },
    };

    const stagehandOptions = stagehandConstructorOptions({ modelId: context.model.modelId, baseURL: this.#opts.baseURL, apiKey: this.#opts.apiKey(), cdpUrl: this.#opts.cdpUrl, middleware });
    // Mode local seulement (X1) : refus avant toute construction si une option ou une variable ouvre Browserbase.
    assertStagehandLocalOnly(stagehandOptions as unknown as Record<string, unknown>, this.#opts.env);
    const stagehand = new Stagehand(stagehandOptions);

    let stepCount = 0;
    let doneInLoop = false;
    let lastStepHadTools = false;
    let toolErrors = 0;
    let actions: StagehandAction[] = [];
    let status: AgentRunStatus;
    let output: unknown = null;
    let failureClass: string | undefined;
    try {
      await stagehand.init();
      const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
      // `startUrl` vide : étape déléguée d'une stratégie E5, l'agent reprend la page où le script l'a laissée.
      if (task.startUrl !== '') await page.goto(task.startUrl, { waitUntil: 'domcontentloaded' });
      const { integrations: _none, ...agentConfig } = stagehandAgentConfig(task);
      const agent = stagehand.agent(agentConfig as unknown as { mode: 'dom' });
      const result = await agent.execute({
        instruction: task.instruction,
        maxSteps: task.limits.maxSteps,
        output: jsonSchemaToZod(task.outputSchema) as never,
        excludeTools: [...STAGEHAND_EXCLUDED_TOOLS],
        signal,
        callbacks: {
          onStepFinish: (event: { toolCalls?: { toolName: string }[]; toolResults?: { output?: unknown }[] }) => {
            stepCount += 1;
            lastStepHadTools = (event.toolCalls ?? []).length > 0;
            for (const call of event.toolCalls ?? []) if (call.toolName === 'done') doneInLoop = true;
            for (const r of event.toolResults ?? []) {
              const out = r.output as { success?: unknown } | undefined;
              if (out !== null && typeof out === 'object' && out.success === false) toolErrors += 1;
            }
          },
        },
      });
      actions = result.actions as StagehandAction[];
      if (toolsetViolation !== undefined) {
        status = 'error';
        failureClass = 'agent_toolset_not_closed';
      } else if (pageRefused) {
        status = 'error';
        failureClass = 'page_refused';
      } else if (costExceeded) {
        status = 'budget_exceeded';
        failureClass = 'run_budget_exceeded';
      } else if (!doneInLoop && stepCount >= task.limits.maxSteps && lastStepHadTools) {
        // Plafond atteint alors que le modèle agissait encore : la sortie du « done » forcé ensuite ne compte pas.
        status = 'max_steps';
        failureClass = 'max_steps';
      } else if (result.completed && result.output !== undefined) {
        status = 'done';
        output = result.output;
      } else {
        status = 'error';
        failureClass = 'no_final_output';
      }
    } catch (error) {
      if (toolsetViolation !== undefined) {
        status = 'error';
        failureClass = 'agent_toolset_not_closed';
      } else if (pageRefused) {
        status = 'error';
        failureClass = 'page_refused';
      } else if (costExceeded) {
        status = 'budget_exceeded';
        failureClass = 'run_budget_exceeded';
      } else if (controller.signal.aborted) {
        status = 'timeout';
        failureClass = 'timeout';
      } else {
        status = 'error';
        failureClass = classifyStagehandError(error);
      }
    } finally {
      clearTimeout(timer);
      await stagehand.close().catch(() => undefined);
    }
    const { usd, usage } = cost();
    return {
      status,
      output,
      steps: stagehandTrace(actions, this.#opts.recorder?.clicks ?? []),
      usage,
      costUsd: usd,
      durationMs: Math.round(performance.now() - t0),
      toolErrors,
      ...(failureClass !== undefined ? { failureClass } : {}),
    };
  }
}

/** Classe d'échec d'une exception Stagehand ou AI SDK (statut HTTP du fournisseur si présent ; 08 §1). */
function classifyStagehandError(error: unknown): string {
  const status = (error as { statusCode?: unknown; status?: unknown } | null)?.statusCode ?? (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return 'llm_auth';
  if (status === 402) return 'llm_quota_exhausted';
  if (status === 429) return 'llm_rate_limited';
  if (typeof status === 'number' && status >= 500) return 'llm_overloaded';
  if (typeof status === 'number' && status >= 400) return 'llm_bad_request';
  return 'engine_error';
}
