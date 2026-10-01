// SPDX-License-Identifier: AGPL-3.0-only
// Nettoyage des prompts de Stagehand avant chaque appel au fournisseur (tâche 2.4 ; 08 §1 « Confidentialité » ; 08 §4
// mesure 5). Stagehand appelle le fournisseur par l'AI SDK, hors du `LlmClient` : son middleware `transformParams` est
// le seul point où appliquer, à TOUT le prompt (message système, messages, appels et résultats d'outils, dont l'arbre
// d'accessibilité de la page) :
// - le masquage `llm.redact` (e-mails, téléphones, motifs configurés, valeurs de secret), avec la même règle que le
//   `LlmClient` : actif seulement si l'admin l'a configuré ;
// - le retrait des jetons d'URL (identifiants, requête, fragment), toujours : une URL de page n'entre dans un prompt que
//   par son origine et son chemin, comme la source d'E4 (`sourceLabel`). La consigne de l'API (écrite par l'utilisateur)
//   n'est pas réécrite.
// Les pièces non textuelles (captures d'écran) ne sont pas modifiables ici ; les identifiants d'outils restent intacts.
import type { Redactor } from '@runtime/llm';

const URL_RE = /\bhttps?:\/\/[^\s"'<>\\`]+/gi;

/** Retire identifiants, requête et fragment de chaque URL http(s) du texte. */
export function cleanUrlTokens(text: string): string {
  return text.replace(URL_RE, (raw) => {
    // Ponctuation finale d'une phrase : hors de l'URL.
    const trail = /[.,;:!?)\]]+$/.exec(raw)?.[0] ?? '';
    const candidate = raw.slice(0, raw.length - trail.length);
    try {
      const u = new URL(candidate);
      return `${u.protocol}//${u.host}${u.pathname}${trail}`;
    } catch {
      // URL illisible : requête et fragment retirés à la main.
      return `${candidate.replace(/[?#].*$/, '')}${trail}`;
    }
  });
}

export type PromptSanitizeOptions = {
  /** Masqueur de `llm.redact` ; absent : pas de masquage (même règle que le `LlmClient`). */
  readonly redactor?: Redactor;
  /** Consigne de l'API : ses occurrences ne sont pas réécrites (ni ses URL). */
  readonly instruction?: string;
};

/** Clés jamais réécrites : structure du prompt, identifiants d'outils, données binaires. */
const OPAQUE_KEYS = new Set(['type', 'role', 'toolCallId', 'toolName', 'mediaType', 'data', 'providerOptions', 'providerMetadata', 'id']);

function sanitizeText(text: string, options: PromptSanitizeOptions): string {
  const instruction = options.instruction;
  const clean = (segment: string): string => {
    const cleaned = cleanUrlTokens(segment);
    return options.redactor === undefined ? cleaned : options.redactor.text(cleaned);
  };
  if (instruction === undefined || instruction === '' || !text.includes(instruction)) return clean(text);
  // La consigne garde ses URL ; le masquage s'y applique comme partout (même règle que le LlmClient).
  const kept = options.redactor === undefined ? instruction : options.redactor.text(instruction);
  return text
    .split(instruction)
    .map((segment) => clean(segment))
    .join(kept);
}

function sanitizeValue(value: unknown, options: PromptSanitizeOptions): unknown {
  if (typeof value === 'string') return sanitizeText(value, options);
  if (Array.isArray(value)) return value.map((v) => sanitizeValue(v, options));
  if (value !== null && typeof value === 'object') {
    if (value instanceof Uint8Array || value instanceof URL) return value;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) out[key] = OPAQUE_KEYS.has(key) ? v : sanitizeValue(v, options);
    return out;
  }
  return value;
}

/** Prompt de l'AI SDK (LanguageModelV2Prompt) nettoyé ; l'entrée n'est pas modifiée. */
export function sanitizeModelPrompt<T>(prompt: readonly T[], options: PromptSanitizeOptions): T[] {
  return prompt.map((message) => sanitizeValue(message, options) as T);
}
