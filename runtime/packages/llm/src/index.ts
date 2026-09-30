// LlmTransport, providers, profils, comptage (tâche 0.4). Squelette tâche 0.1.
export const PACKAGE_NAME = '@runtime/llm';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmTransport {
  complete(messages: LlmMessage[]): Promise<string>;
}
