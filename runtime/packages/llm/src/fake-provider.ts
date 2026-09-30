// Faux fournisseur scripté compatible OpenAI (15 §4) : serveur HTTP local, scénarios par rôle et par étape, compteur de
// requêtes, point d'observation des appels d'outils. Sert toute la CI ; les cassettes msw ne servent qu'au contrat du client.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUsage {
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  cost?: number;
}

export interface FakeToolCall {
  name: string;
  arguments: unknown;
  id?: string;
}

export type ScriptedResponse =
  | {
      kind: 'completion';
      content?: string | null;
      toolCalls?: FakeToolCall[];
      finishReason?: string;
      reasoning?: string;
      refusal?: string;
      usage?: FakeUsage;
      delayMs?: number;
    }
  | { kind: 'error'; status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number }
  /** Corps brut (SSE ou JSON manuel). */
  | { kind: 'raw'; status?: number; contentType: string; body: string; delayMs?: number }
  /** La connexion est ouverte puis coupée sans réponse. */
  | { kind: 'drop' };

export interface FakeRequestContext {
  role: string;
  step: number;
  body: Record<string, unknown>;
}

export type ScriptedStep = ScriptedResponse | ((ctx: FakeRequestContext) => ScriptedResponse);
export type FakeScenarios = Record<string, ScriptedStep[]>;

export interface FakeCall {
  role: string;
  step: number;
  path: string;
  /** Corps tel que reçu : point d'observation (masquage avant envoi, contenu envoyé). */
  body: Record<string, unknown>;
  /** En-têtes sans `authorization`. */
  headers: Record<string, string>;
}

export interface ObservedToolCall {
  role: string;
  step: number;
  id: string;
  name: string;
  arguments: unknown;
  /** L'outil figurait dans la liste `tools` de la requête qui l'a provoqué. */
  inList: boolean;
  /** Une requête ultérieure contient un message `tool` qui lui répond : le runtime l'a exécuté. */
  answered: boolean;
}

export interface FakeProvider {
  /** Base à donner comme `base_url` (se termine par `/v1`). */
  readonly baseUrl: string;
  /** Nombre total de requêtes reçues. */
  readonly requests: number;
  readonly byRole: Readonly<Record<string, number>>;
  readonly calls: readonly FakeCall[];
  /** Requêtes sans scénario restant (le faux répond 500 : un test strict l'exige vide). */
  readonly unscripted: readonly { role: string; step: number }[];
  observeToolCalls(): ObservedToolCall[];
  /** Appels d'outils hors de la liste de la requête (fixture d'injection de prompt). */
  offListToolCalls(): ObservedToolCall[];
  setScenario(role: string, steps: ScriptedStep[]): void;
  reset(): void;
  close(): Promise<void>;
}

export interface FakeProviderOptions {
  scenarios?: FakeScenarios;
  /** En-tête qui porte le rôle (défaut `x-fake-role`) ; sinon le rôle est le nom du modèle demandé. */
  roleHeader?: string;
}

/** Constructeurs de réponses scriptées. */
export const scripted = {
  text: (content: string, usage?: FakeUsage): ScriptedResponse => ({ kind: 'completion', content, ...(usage ? { usage } : {}) }),
  json: (value: unknown, usage?: FakeUsage): ScriptedResponse => ({ kind: 'completion', content: JSON.stringify(value), ...(usage ? { usage } : {}) }),
  toolCalls: (toolCalls: FakeToolCall[], usage?: FakeUsage): ScriptedResponse => ({
    kind: 'completion',
    content: null,
    toolCalls,
    finishReason: 'tool_calls',
    ...(usage ? { usage } : {}),
  }),
  truncated: (partial: string, usage?: FakeUsage): ScriptedResponse => ({ kind: 'completion', content: partial, finishReason: 'length', ...(usage ? { usage } : {}) }),
  refusal: (message = 'I cannot help with that.'): ScriptedResponse => ({ kind: 'completion', content: null, refusal: message, finishReason: 'stop' }),
  empty: (): ScriptedResponse => ({ kind: 'completion', content: '' }),
  error: (status: number, body?: unknown, headers?: Record<string, string>): ScriptedResponse => ({
    kind: 'error',
    status,
    body: body ?? { error: { message: `fake error ${status}` } },
    ...(headers ? { headers } : {}),
  }),
  drop: (): ScriptedResponse => ({ kind: 'drop' }),
  raw: (contentType: string, body: string, status = 200): ScriptedResponse => ({ kind: 'raw', contentType, body, status }),
};

function completionBody(res: Extract<ScriptedResponse, { kind: 'completion' }>, model: string, n: number): Record<string, unknown> {
  const toolCalls = res.toolCalls?.map((c, i) => ({
    id: c.id ?? `call_${n}_${i}`,
    type: 'function',
    function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) },
  }));
  const message: Record<string, unknown> = { role: 'assistant', content: res.content ?? null };
  if (toolCalls) message['tool_calls'] = toolCalls;
  if (res.reasoning !== undefined) message['reasoning_content'] = res.reasoning;
  if (res.refusal !== undefined) message['refusal'] = res.refusal;
  return {
    id: `fake-${n}`,
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message, finish_reason: res.finishReason ?? 'stop' }],
    usage: usageBody(res.usage),
  };
}

function usageBody(u: FakeUsage | undefined): Record<string, unknown> {
  const usage = u ?? { prompt_tokens: 10, completion_tokens: 5 };
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.prompt_tokens + usage.completion_tokens,
    ...(usage.cached_tokens !== undefined ? { prompt_tokens_details: { cached_tokens: usage.cached_tokens } } : {}),
    ...(usage.reasoning_tokens !== undefined ? { completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens } } : {}),
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
  };
}

/** Réponse en flux SSE : le texte en deux morceaux, les outils en deux morceaux d'arguments, usage en dernier. */
function sseBody(res: Extract<ScriptedResponse, { kind: 'completion' }>, model: string, n: number): string {
  const events: unknown[] = [];
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: `fake-${n}`,
    object: 'chat.completion.chunk',
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  events.push(chunk({ role: 'assistant', content: '' }));
  if (res.reasoning !== undefined) events.push(chunk({ reasoning_content: res.reasoning }));
  if (typeof res.content === 'string' && res.content !== '') {
    const mid = Math.ceil(res.content.length / 2);
    events.push(chunk({ content: res.content.slice(0, mid) }), chunk({ content: res.content.slice(mid) }));
  }
  res.toolCalls?.forEach((c, i) => {
    const args = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments);
    const mid = Math.ceil(args.length / 2);
    const id = c.id ?? `call_${n}_${i}`;
    events.push(chunk({ tool_calls: [{ index: i, id, type: 'function', function: { name: c.name, arguments: args.slice(0, mid) } }] }));
    events.push(chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(mid) } }] }));
  });
  events.push(chunk({}, res.finishReason ?? 'stop'));
  events.push({ id: `fake-${n}`, object: 'chat.completion.chunk', model, choices: [], usage: usageBody(res.usage) });
  return `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return Buffer.concat(parts).toString('utf8');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function createFakeProvider(options: FakeProviderOptions = {}): Promise<FakeProvider> {
  const roleHeader = (options.roleHeader ?? 'x-fake-role').toLowerCase();
  const scenarios = new Map<string, ScriptedStep[]>(Object.entries(options.scenarios ?? {}));
  const counters = new Map<string, number>();
  const calls: FakeCall[] = [];
  const unscripted: { role: string; step: number }[] = [];
  const emitted: Omit<ObservedToolCall, 'answered'>[] = [];
  let total = 0;

  const respond = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
    } catch {
      /* corps illisible : enregistré vide */
    }
    total += 1;
    const header = req.headers[roleHeader];
    const model = typeof body['model'] === 'string' ? body['model'] : 'fake-model';
    const role = (Array.isArray(header) ? header[0] : header) ?? model;
    const step = counters.get(role) ?? 0;
    counters.set(role, step + 1);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (k !== 'authorization' && typeof v === 'string') headers[k] = v;
    calls.push({ role, step, path: req.url ?? '', body, headers });

    const scripted_ = scenarios.get(role)?.[step];
    if (scripted_ === undefined) {
      unscripted.push({ role, step });
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: `fake provider : aucun scénario pour ${role} à l'étape ${step}` } }));
      return;
    }
    const plan = typeof scripted_ === 'function' ? scripted_({ role, step, body }) : scripted_;
    if (plan.kind === 'drop') {
      req.socket.destroy();
      return;
    }
    if ('delayMs' in plan && plan.delayMs !== undefined) await sleep(plan.delayMs);
    if (plan.kind === 'error') {
      res.writeHead(plan.status, { 'content-type': 'application/json', ...plan.headers }).end(JSON.stringify(plan.body));
      return;
    }
    if (plan.kind === 'raw') {
      res.writeHead(plan.status ?? 200, { 'content-type': plan.contentType }).end(plan.body);
      return;
    }
    const tools = Array.isArray(body['tools']) ? (body['tools'] as { function?: { name?: string } }[]) : [];
    const listed = new Set(tools.map((t) => t.function?.name));
    plan.toolCalls?.forEach((c, i) => {
      emitted.push({ role, step, id: c.id ?? `call_${total}_${i}`, name: c.name, arguments: c.arguments, inList: listed.has(c.name) });
    });
    if (body['stream'] === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(sseBody(plan, model, total));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(completionBody(plan, model, total)));
  };

  const server: Server = createServer((req, res) => {
    respond(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  const answeredIds = (): Set<string> => {
    const ids = new Set<string>();
    for (const c of calls) {
      const messages = Array.isArray(c.body['messages']) ? (c.body['messages'] as { role?: string; tool_call_id?: string }[]) : [];
      for (const m of messages) if (m.role === 'tool' && typeof m.tool_call_id === 'string') ids.add(m.tool_call_id);
    }
    return ids;
  };

  const provider: FakeProvider = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return total;
    },
    get byRole() {
      return Object.fromEntries(counters);
    },
    calls,
    unscripted,
    observeToolCalls() {
      const answered = answeredIds();
      return emitted.map((e) => ({ ...e, answered: answered.has(e.id) }));
    },
    offListToolCalls() {
      return this.observeToolCalls().filter((c) => !c.inList);
    },
    setScenario(role, steps) {
      scenarios.set(role, steps);
      counters.set(role, 0);
    },
    reset() {
      scenarios.clear();
      counters.clear();
      calls.length = 0;
      unscripted.length = 0;
      emitted.length = 0;
      total = 0;
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
  return provider;
}
