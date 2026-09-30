// Types du transport Chat Completions (08 §1). Les messages assistant sont gardés verbatim (champs inconnus compris).
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ContentPart = { type: string; text?: string; [key: string]: unknown };

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** DeepSeek refuse un historique où ce champ est retiré : on renvoie le message tel que reçu. */
  reasoning_content?: string;
  [extra: string]: unknown;
}

export type JsonSchema = boolean | { [keyword: string]: unknown };

export interface ToolDef {
  type: 'function';
  function: { name: string; description?: string; parameters: JsonSchema; strict?: boolean };
}

export type ToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };

export type ResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: JsonSchema } };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: ToolChoice;
  response_format?: ResponseFormat;
  max_tokens?: number;
  temperature?: number;
  /** Faux par défaut (08 §1). En flux, le transport agrège et ne rend l'appel d'outils qu'à `finish_reason: tool_calls`. */
  stream?: boolean;
  /** Champs propres au fournisseur (ex. `provider.require_parameters` d'OpenRouter), fusionnés dans le corps. */
  extraBody?: Record<string, unknown>;
}

/** Usage tel que renvoyé par le fournisseur (tous les champs sont facultatifs selon le fournisseur). */
export interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; [k: string]: unknown };
  completion_tokens_details?: { reasoning_tokens?: number; [k: string]: unknown };
  prompt_cache_hit_tokens?: number;
  [extra: string]: unknown;
}

export interface ChatResult {
  id: string | null;
  model: string | null;
  message: ChatMessage;
  finish_reason: string | null;
  usage: RawUsage | null;
  streamed: boolean;
  /** Durée de l'appel HTTP, pour les journaux d'essais (INV2). */
  duration_ms: number;
}

export interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface LlmTransport {
  readonly kind: string;
  /** Une seule tentative : réessais, repli et comptage vivent dans `LlmClient`. Lève `LlmError`. */
  chat(request: ChatRequest, options?: CallOptions): Promise<ChatResult>;
}
