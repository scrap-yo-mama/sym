// OpenAICompatTransport : `fetch` maison sur `POST {base_url}/chat/completions` (aucun SDK, 08 §1). Une tentative par appel.
import { redactArtifactText, Secret, SecretValueRegistry } from '@runtime/core';
import { classifyFailure, extractErrorFields, parseRetryAfter } from './classify.js';
import { LlmError, type LlmErrorClass } from './errors.js';
import type { CallOptions, ChatMessage, ChatRequest, ChatResult, LlmTransport, RawUsage, ToolCall } from './types.js';

export interface OpenAICompatOptions {
  baseUrl: string;
  apiKey: Secret;
  /** En-têtes personnalisés : chiffrés comme la clé côté dépôt, `Secret` ici. */
  headers?: Record<string, Secret | string>;
  timeoutMs?: number;
  /** Plafond de taille du corps envoyé (octets) : au-delà, `context_length` sans appel réseau. */
  maxRequestBytes?: number;
  /** Corps statique ajouté à chaque appel (ex. `{provider:{require_parameters:true}}`). */
  extraBody?: Record<string, unknown>;
  fetch?: typeof fetch;
  now?: () => number;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class OpenAICompatTransport implements LlmTransport {
  readonly kind = 'openai-compat';
  readonly #opts: OpenAICompatOptions;
  readonly #url: string;
  /** Valeurs de secret de CE transport : un fournisseur qui renvoie la clé dans son message d'erreur ne la fait pas fuiter. */
  readonly #secrets = new SecretValueRegistry();

  constructor(opts: OpenAICompatOptions) {
    this.#opts = opts;
    this.#secrets.add(opts.apiKey.reveal());
    for (const value of Object.values(opts.headers ?? {})) this.#secrets.add(value instanceof Secret ? value.reveal() : value);
    this.#url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  #excerpt(text: string): string {
    return redactArtifactText(this.#secrets.redactText(text.replace(/\s+/g, ' ').trim().slice(0, 300)));
  }

  #buildBody(req: ChatRequest): string {
    const stream = req.stream === true;
    const body: Record<string, unknown> = {
      ...this.#opts.extraBody,
      ...req.extraBody,
      model: req.model,
      messages: req.messages,
      stream,
    };
    if (stream) body['stream_options'] = { include_usage: true };
    if (req.tools !== undefined && req.tools.length > 0) body['tools'] = req.tools;
    if (req.tool_choice !== undefined) body['tool_choice'] = req.tool_choice;
    if (req.response_format !== undefined) body['response_format'] = req.response_format;
    if (req.max_tokens !== undefined) body['max_tokens'] = req.max_tokens;
    if (req.temperature !== undefined) body['temperature'] = req.temperature;
    return JSON.stringify(body);
  }

  #headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    for (const [name, value] of Object.entries(this.#opts.headers ?? {})) headers[name.toLowerCase()] = value instanceof Secret ? value.reveal() : value;
    headers['authorization'] = `Bearer ${this.#opts.apiKey.reveal()}`;
    return headers;
  }

  async chat(req: ChatRequest, options: CallOptions = {}): Promise<ChatResult> {
    const body = this.#buildBody(req);
    const max = this.#opts.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    if (Buffer.byteLength(body) > max) {
      throw new LlmError('context_length', `corps de requête supérieur au plafond (${max} octets)`, { code: 'request_too_large' });
    }
    const timeoutMs = options.timeoutMs ?? this.#opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = AbortSignal.any(signals);
    const started = Date.now();
    const doFetch = this.#opts.fetch ?? globalThis.fetch;

    let response: Response;
    try {
      response = await doFetch(this.#url, { method: 'POST', headers: this.#headers(), body, signal });
    } catch (error) {
      throw this.#networkError(error, options.signal);
    }

    const retryAfterMs = parseRetryAfter(response.headers, this.#opts.now);
    const contentType = response.headers.get('content-type') ?? '';
    try {
      if (!response.ok) {
        const text = await response.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { error: { message: text } };
        }
        const info = classifyFailure({ status: response.status, body: parsed, retryAfterMs });
        throw new LlmError(info.cls, `HTTP ${response.status}${info.detail ? ` : ${this.#excerpt(info.detail)}` : ''}`, {
          status: response.status,
          ...(info.code !== undefined ? { code: info.code } : {}),
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      }
      if (contentType.includes('text/event-stream')) {
        // Flux demandé, ou serveur qui répond en flux à `stream: false` : même agrégation.
        const completion = await this.#readStream(response, retryAfterMs);
        return this.#interpret(completion, true, Date.now() - started, response.status);
      }
      const text = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (cause) {
        throw new LlmError('empty_response', text.trim() === '' ? 'corps vide' : 'corps non JSON', { status: response.status, cause });
      }
      return this.#interpret(json, false, Date.now() - started, response.status);
    } catch (error) {
      if (error instanceof LlmError) throw error;
      throw this.#networkError(error, options.signal);
    }
  }

  #networkError(error: unknown, callerSignal: AbortSignal | undefined): Error {
    if (callerSignal?.aborted === true) return error instanceof Error ? error : new Error('aborted');
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return new LlmError('timeout', 'délai dépassé', { cause: error });
    const code = isRecord((error as { cause?: unknown } | null)?.cause) ? String((error as { cause: Record<string, unknown> }).cause['code'] ?? '') : '';
    return new LlmError('network', `échec réseau${code ? ` (${code})` : ''}`, { cause: error });
  }

  /** Lit un flux SSE et le replie en une réponse complète ; les appels d'outils se distinguent par `id`. */
  async #readStream(response: Response, retryAfterMs: number | undefined): Promise<Record<string, unknown>> {
    if (response.body === null) throw new LlmError('stream_error', 'flux sans corps', { inner: 'empty_response' });
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let reasoning: { field: string; text: string } | undefined;
    let id: string | null = null;
    let model: string | null = null;
    let finish: string | null = null;
    let usage: RawUsage | null = null;
    let done = false;
    const calls: { id: string; index: number | undefined; name: string; args: string }[] = [];

    const onData = (data: string): void => {
      if (data === '[DONE]') {
        done = true;
        return;
      }
      let chunk: unknown;
      try {
        chunk = JSON.parse(data);
      } catch (cause) {
        throw new LlmError('stream_error', 'événement de flux illisible', { inner: 'network', cause });
      }
      if (!isRecord(chunk)) return;
      if ('error' in chunk && chunk['error'] !== null && chunk['error'] !== undefined) {
        const status = isRecord(chunk['error']) && typeof chunk['error']['code'] === 'number' ? chunk['error']['code'] : 500;
        const info = classifyFailure({ status, body: chunk, retryAfterMs });
        throw new LlmError('stream_error', `erreur en cours de flux (${info.cls})${info.detail ? ` : ${this.#excerpt(info.detail)}` : ''}`, {
          inner: info.cls,
          ...(info.code !== undefined ? { code: info.code } : {}),
        });
      }
      if (typeof chunk['id'] === 'string') id = chunk['id'];
      if (typeof chunk['model'] === 'string') model = chunk['model'];
      if (isRecord(chunk['usage'])) usage = chunk['usage'] as RawUsage;
      const choice = Array.isArray(chunk['choices']) ? chunk['choices'][0] : undefined;
      if (!isRecord(choice)) return;
      if (typeof choice['finish_reason'] === 'string') finish = choice['finish_reason'];
      const delta = choice['delta'];
      if (!isRecord(delta)) return;
      if (typeof delta['content'] === 'string') content += delta['content'];
      for (const field of ['reasoning_content', 'reasoning']) {
        if (typeof delta[field] === 'string') reasoning = { field, text: (reasoning?.field === field ? reasoning.text : '') + delta[field] };
      }
      if (Array.isArray(delta['tool_calls'])) {
        for (const raw of delta['tool_calls']) {
          if (!isRecord(raw)) continue;
          const fn = isRecord(raw['function']) ? raw['function'] : {};
          const callId = typeof raw['id'] === 'string' && raw['id'] !== '' ? raw['id'] : undefined;
          const index = typeof raw['index'] === 'number' ? raw['index'] : undefined;
          let target = callId !== undefined ? calls.find((c) => c.id === callId) : undefined;
          if (target === undefined && callId === undefined) {
            target = index !== undefined ? [...calls].reverse().find((c) => c.index === index) : calls[calls.length - 1];
          }
          if (target === undefined) {
            target = { id: callId ?? `call_${calls.length}`, index, name: '', args: '' };
            calls.push(target);
          }
          if (typeof fn['name'] === 'string') target.name += fn['name'];
          if (typeof fn['arguments'] === 'string') target.args += fn['arguments'];
        }
      }
    };

    const flush = (final: boolean): void => {
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        let raw: string;
        if (match !== null) {
          raw = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
        } else if (final && buffer.trim() !== '') {
          raw = buffer;
          buffer = '';
        } else return;
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data !== '') onData(data);
      }
    };

    try {
      for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(part, { stream: true });
        flush(false);
      }
      buffer += decoder.decode();
      flush(true);
    } catch (error) {
      if (error instanceof LlmError) throw error;
      const name = error instanceof Error ? error.name : '';
      const inner: LlmErrorClass = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
      throw new LlmError('stream_error', 'flux interrompu', { inner, cause: error });
    }
    if (finish === null && !done) throw new LlmError('stream_error', 'flux coupé avant finish_reason', { inner: 'network', usage });

    const message: Record<string, unknown> = { role: 'assistant', content: content === '' && calls.length > 0 ? null : content };
    if (reasoning !== undefined) message[reasoning.field] = reasoning.text;
    // Un outil ne s'exécute qu'à finish_reason: tool_calls : sinon les appels partiels sont écartés.
    if (calls.length > 0 && finish === 'tool_calls') {
      message['tool_calls'] = calls.map((c): ToolCall => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.args } }));
    }
    return { id, model, choices: [{ index: 0, message, finish_reason: finish }], usage };
  }

  /** Interprète une réponse 2xx : erreurs portées par le corps, refus, troncature, réponse vide. */
  #interpret(json: unknown, streamed: boolean, durationMs: number, status: number): ChatResult {
    if (!isRecord(json)) throw new LlmError('empty_response', 'réponse inattendue', { status });
    const usage = isRecord(json['usage']) ? (json['usage'] as RawUsage) : null;
    if (json['error'] !== undefined && json['error'] !== null) {
      // OpenRouter peut répondre 200 avec une erreur amont dans le corps.
      const fields = extractErrorFields(json);
      const asStatus = typeof fields.code === 'number' && fields.code >= 400 ? fields.code : 502;
      const info = classifyFailure({ status: asStatus, body: json });
      throw new LlmError(info.cls, `erreur dans le corps 200${info.detail ? ` : ${this.#excerpt(info.detail)}` : ''}`, {
        status,
        ...(info.code !== undefined ? { code: info.code } : {}),
        usage,
      });
    }
    const choice = Array.isArray(json['choices']) ? json['choices'][0] : undefined;
    if (!isRecord(choice) || !isRecord(choice['message'])) throw new LlmError('empty_response', 'aucun choix dans la réponse', { status, usage });
    const message = choice['message'] as ChatMessage;
    const finish = typeof choice['finish_reason'] === 'string' ? choice['finish_reason'] : null;
    const result: ChatResult = {
      id: typeof json['id'] === 'string' ? json['id'] : null,
      model: typeof json['model'] === 'string' ? json['model'] : null,
      message,
      finish_reason: finish,
      usage,
      streamed,
      duration_ms: durationMs,
    };
    if (finish === 'content_filter') throw new LlmError('llm_refused', 'finish_reason content_filter', { status, usage });
    if (typeof message['refusal'] === 'string' && message['refusal'] !== '') {
      throw new LlmError('llm_refused', 'le modèle a refusé de répondre', { status, usage });
    }
    if (finish === 'error') {
      const info = classifyFailure({ status: 502, body: choice });
      throw new LlmError(info.cls, `finish_reason error${info.detail ? ` : ${this.#excerpt(info.detail)}` : ''}`, { status, usage });
    }
    if (finish === 'length') throw new LlmError('truncated', 'finish_reason length (max_tokens atteint)', { status, usage, partial: result });
    const hasText = typeof message.content === 'string' ? message.content.trim() !== '' : Array.isArray(message.content) && message.content.length > 0;
    const hasTools = Array.isArray(message.tool_calls) && message.tool_calls.length > 0;
    if (!hasText && !hasTools) throw new LlmError('empty_response', 'contenu vide', { status, usage });
    return result;
  }
}
