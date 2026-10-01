// Moteur B du spike 0.6a : Stagehand 3.7.3 `agent()` derrière `AgentEngine` (protocole §3). Paquet d'évaluation isolé
// (§13) : jamais importé par packages/* ni apps/*. Tel que livré : prompt système de la bibliothèque non modifié.
// Stagehand pilote Chromium par son propre client CDP (cdpUrl) : il n'est PAS compatible `agent_step` (07 §3).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Stagehand, type ModelConfiguration } from '@browserbasehq/stagehand';
import type { AgentEngine, AgentRunContext, AgentRunResult, AgentRunStatus, AgentTask, AgentTraceStep } from '@runtime/core';
import { computeUsage, type ModelPrice, type RawUsage } from '@runtime/llm';
import { z } from 'zod';
import { assertStagehandLocalOnly } from './guards.ts';

export const STAGEHAND_VERSION = '3.7.3';

type Middleware = NonNullable<Extract<ModelConfiguration, { modelName: unknown }>['middleware']>;

/** Un appel LLM vu par le middleware (usage, arguments d'outils) : base du coût et du contrôle canari. */
export interface StagehandLlmCall {
  readonly temperatureSent: number | undefined;
  readonly usage: RawUsage;
  readonly toolCalls: readonly { name: string; input: string }[];
}

export interface StagehandEngineOptions {
  readonly cdpUrl: string;
  readonly baseURL: string;
  /** Clé du fournisseur : passée à Stagehand au moment du run, jamais journalisée. */
  readonly apiKey: () => string;
  readonly price: ModelPrice | undefined;
  readonly startUrl: string;
  readonly onLlmCall?: (call: StagehandLlmCall) => void;
}

/** JSON Schema (sous-ensemble des fixtures) vers Zod : `execute({ output })` attend un objet Zod (§15). */
export function jsonSchemaToZod(schema: Readonly<Record<string, unknown>>): z.ZodType {
  const type = schema['type'];
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

export class StagehandEngine implements AgentEngine {
  readonly id = 'stagehand' as const;
  readonly version = STAGEHAND_VERSION;
  readonly capabilities = { agentStepCompatible: false } as const;
  readonly #opts: StagehandEngineOptions;
  /** Types d'actions Stagehand du dernier run (trace de diagnostic, sans contenu de page). */
  lastActionTypes: string[] = [];

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

    const cost = (): { usd: number | null; usage: AgentRunResult['usage'] } => {
      let known = 0;
      let unpriced = false;
      const u = { tokensIn: 0, tokensCached: 0, tokensOut: 0, tokensReasoning: 0, usageEstimated: false };
      for (const call of calls) {
        const c = computeUsage({ raw: call.usage, price: this.#opts.price, requestChars: 0, responseChars: 0 });
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

    // Température fixée par middleware (§15 : la boucle agent() ne transmet pas clientOptions.temperature).
    const middleware: Middleware = {
      transformParams: async ({ params }) => ({ ...params, temperature }),
      wrapGenerate: async ({ doGenerate, params }) => {
        const result = await doGenerate();
        const usage = result.usage as V2Usage;
        const raw: RawUsage = {
          ...(usage.inputTokens !== undefined ? { prompt_tokens: usage.inputTokens } : {}),
          ...(usage.outputTokens !== undefined ? { completion_tokens: usage.outputTokens } : {}),
          prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
          completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 },
        };
        const toolCalls = result.content
          .filter((part): part is Extract<typeof part, { type: 'tool-call' }> => part.type === 'tool-call')
          .map((part) => ({ name: part.toolName, input: typeof part.input === 'string' ? part.input : JSON.stringify(part.input) }));
        const call: StagehandLlmCall = { temperatureSent: params.temperature, usage: raw, toolCalls };
        calls.push(call);
        this.#opts.onLlmCall?.(call);
        const spent = cost().usd;
        if (spent !== null && spent >= task.limits.maxCostUsd) {
          costExceeded = true;
          controller.abort(new Error('run_budget_exceeded'));
        }
        return result;
      },
    };

    const cacheDir = await mkdtemp(join(tmpdir(), 'zz_test_spike_stagehand_cache_'));
    const stagehandOptions: ConstructorParameters<typeof Stagehand>[0] = {
      env: 'LOCAL',
      model: {
        modelName: `openai/${context.model.modelId}`,
        baseURL: this.#opts.baseURL,
        apiKey: this.#opts.apiKey(),
        openaiEndpointFormat: 'chat',
        middleware,
      } as ModelConfiguration,
      localBrowserLaunchOptions: { cdpUrl: this.#opts.cdpUrl },
      disableAPI: true,
      // Exigé par Stagehand 3.7.3 pour `output`, `excludeTools`, `signal` et les rappels d'agent (validateExperimentalFeatures).
      experimental: true,
      disablePino: true,
      verbose: process.env["ZZ_SPIKE_DEBUG"] === "1" ? 2 : 0,
      logger: process.env["ZZ_SPIKE_DEBUG"] === "1" ? (line) => console.error(`[stagehand] ${line.category ?? ""}: ${String(line.message).slice(0, 300)}`) : () => undefined,
      cacheDir,
    };
    // Mode local seulement (§13, §15, X1) : refus avant toute construction si une option ou une variable ouvre Browserbase.
    assertStagehandLocalOnly(stagehandOptions as unknown as Record<string, unknown>);
    const stagehand = new Stagehand(stagehandOptions);

    let stepCount = 0;
    let doneInLoop = false;
    let lastStepHadTools = false;
    const steps: AgentTraceStep[] = [];
    let status: AgentRunStatus;
    let output: unknown = null;
    let failureClass: string | undefined;
    try {
      await stagehand.init();
      const page = stagehand.context.pages()[0] ?? (await stagehand.context.newPage());
      await page.goto(this.#opts.startUrl, { waitUntil: 'domcontentloaded' });
      const agent = stagehand.agent({ mode: 'dom' });
      const result = await agent.execute({
        instruction: task.instruction,
        maxSteps: task.limits.maxSteps,
        output: jsonSchemaToZod(task.outputSchema) as never,
        excludeTools: ['search'],
        signal,
        callbacks: {
          onStepFinish: (event: { toolCalls?: { toolName: string }[] }) => {
            stepCount += 1;
            lastStepHadTools = (event.toolCalls ?? []).length > 0;
            for (const call of event.toolCalls ?? []) {
              if (call.toolName === 'done') doneInLoop = true;
            }
          },
        },
      });
      this.lastActionTypes = result.actions.map((a) => a.type);
      for (const action of result.actions) {
        if (action.type === 'done') continue;
        steps.push({
          index: steps.length,
          action: stagehandActionKind(action.type),
          url: typeof action.pageUrl === 'string' ? action.pageUrl : '',
          executed: true,
          durationMs: typeof action.timeMs === 'number' ? action.timeMs : 0,
        });
      }
      if (costExceeded) {
        status = 'budget_exceeded';
        failureClass = 'run_budget_exceeded';
      } else if (!doneInLoop && stepCount >= task.limits.maxSteps && lastStepHadTools) {
        // Plafond d'étapes atteint alors que le modèle agissait encore : la sortie de l'appel « done » que Stagehand force
        // ensuite ne compte pas (§6 : un run qui atteint un plafond est un échec).
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
      if (costExceeded) {
        status = 'budget_exceeded';
        failureClass = 'run_budget_exceeded';
      } else if (controller.signal.aborted) {
        status = 'timeout';
        failureClass = 'timeout';
      } else {
        status = 'error';
        failureClass = classifyStagehandError(error);
        if (process.env["ZZ_SPIKE_DEBUG"] === "1") console.error(error);
      }
    } finally {
      clearTimeout(timer);
      await stagehand.close().catch(() => undefined);
      await rm(cacheDir, { recursive: true, force: true }).catch(() => undefined);
    }
    const { usd, usage } = cost();
    return {
      status,
      output,
      steps,
      usage,
      costUsd: usd,
      durationMs: Math.round(performance.now() - t0),
      toolErrors: 0,
      ...(failureClass !== undefined ? { failureClass } : {}),
    };
  }
}

/** Classe d'échec grossière d'une exception Stagehand ou AI SDK (statut HTTP du fournisseur si présent). */
function classifyStagehandError(error: unknown): string {
  const status = (error as { statusCode?: unknown; status?: unknown } | null)?.statusCode ?? (error as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return 'llm_auth';
  if (status === 402) return 'llm_quota_exhausted';
  if (status === 429) return 'llm_rate_limited';
  if (typeof status === 'number' && status >= 500) return 'llm_overloaded';
  if (typeof status === 'number' && status >= 400) return 'llm_bad_request';
  return 'engine_error';
}

/** Correspondance indicative des outils Stagehand vers les cinq actions de `agent_step` (trace seulement). */
function stagehandActionKind(type: string): AgentTraceStep['action'] {
  if (type === 'goto' || type === 'navback') return 'navigate';
  if (type === 'click' || type === 'act' || type === 'clickAndHold' || type === 'dragAndDrop') return 'click';
  if (type === 'type' || type === 'fillForm' || type === 'fillFormVision' || type === 'keys') return 'type';
  if (type === 'scroll') return 'scroll';
  return 'read';
}
