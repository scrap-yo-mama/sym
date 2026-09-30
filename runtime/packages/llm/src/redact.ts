// SPDX-License-Identifier: AGPL-3.0-only
// `llm.redact` (08 §1, Confidentialité) : masque e-mails, téléphones et motifs configurés AVANT l'envoi au fournisseur.
import { secretValues, type SecretValueRegistry } from '@runtime/core';
import type { ChatMessage } from './types.js';

export interface RedactConfig {
  /** Défaut : vrai. */
  emails?: boolean;
  /** Défaut : vrai. */
  phones?: boolean;
  /** Motifs supplémentaires (expressions régulières, configuration d'opérateur : 200 caractères au plus chacun). */
  patterns?: string[];
  /** Balaie aussi les valeurs de secret connues du processus (défaut : vrai). */
  secrets?: boolean;
}

export const EMAIL_PLACEHOLDER = '[email]';
export const PHONE_PLACEHOLDER = '[téléphone]';
export const PATTERN_PLACEHOLDER = '[masqué]';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
// International (+33 1 23 45 67 89, 0033…), national français (01 23 45 67 89), nord-américain (555-123-4567).
const PHONES = [
  /(?<![\w+])(?:\+|00)\d{1,3}[\d ().-]{6,16}\d(?!\w)/g,
  /(?<![\w.-])0[1-9](?:[ .-]?\d{2}){4}(?![\w-])/g,
  /(?<![\w.-])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])/g,
];

export interface Redactor {
  text(input: string): string;
  messages(messages: ChatMessage[]): ChatMessage[];
}

export function createRedactor(config: RedactConfig, registry: SecretValueRegistry = secretValues): Redactor {
  const custom = (config.patterns ?? []).map((p) => {
    if (p.length > 200) throw new Error('llm.redact : motif trop long (200 caractères au plus)');
    return new RegExp(p, 'gu');
  });
  const text = (input: string): string => {
    let out = input;
    if (config.secrets !== false) out = registry.redactText(out);
    if (config.emails !== false) out = out.replace(EMAIL, EMAIL_PLACEHOLDER);
    if (config.phones !== false) for (const re of PHONES) out = out.replace(re, PHONE_PLACEHOLDER);
    for (const re of custom) out = out.replace(re, PATTERN_PLACEHOLDER);
    return out;
  };
  const message = (m: ChatMessage): ChatMessage => {
    const copy: ChatMessage = { ...m };
    if (typeof m.content === 'string') copy.content = text(m.content);
    else if (Array.isArray(m.content)) {
      copy.content = m.content.map((part) => (typeof part.text === 'string' ? { ...part, text: text(part.text) } : part));
    }
    if (m.tool_calls !== undefined) {
      copy.tool_calls = m.tool_calls.map((tc) => ({ ...tc, function: { ...tc.function, arguments: text(tc.function.arguments) } }));
    }
    return copy;
  };
  return { text, messages: (messages) => messages.map(message) };
}
