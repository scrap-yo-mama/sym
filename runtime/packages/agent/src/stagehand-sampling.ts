// SPDX-License-Identifier: AGPL-3.0-only
// Échantillonnage du moteur Stagehand : il appelle le fournisseur par l'AI SDK, hors du LlmClient, donc hors de son retrait de
// paramètres (client.ts). Même règle, même profil sondé (`withoutUnsupportedSampling`) : un paramètre que le modèle refuse
// (claude-opus-4-8 compatible OpenAI : 400 sur `temperature` et `top_p`) n'est jamais envoyé.
import { samplingParamsRejected, withoutUnsupportedSampling, type CapabilityProfile, type SamplingSupport } from '@runtime/llm';

export interface SamplingParams {
  temperature?: number | undefined;
  topP?: number | undefined;
}

/** Paramètres à envoyer (ceux que le profil refuse sont absents) et noms retirés. */
export function adaptSampling(profile: CapabilityProfile | undefined, params: SamplingParams): SamplingParams & { dropped: (keyof SamplingSupport)[] } {
  const { request, dropped } = withoutUnsupportedSampling(profile, {
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(params.topP === undefined ? {} : { top_p: params.topP }),
  });
  return {
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.top_p === undefined ? {} : { topP: request.top_p }),
    dropped,
  };
}

/** Texte d'une APICallError de l'AI SDK (message et corps de réponse) si c'est un 400, sinon null. */
function badRequestText(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const e = error as { statusCode?: unknown; message?: unknown; responseBody?: unknown };
  if (e.statusCode !== 400) return null;
  return `${typeof e.message === 'string' ? e.message : ''} ${typeof e.responseBody === 'string' ? e.responseBody : ''}`;
}

/**
 * Repli quand le profil n'a pas de mesure de `sampling` (production avant la route de sonde) : un 400 qui nomme un paramètre
 * d'échantillonnage envoyé (`temperature`, `top_p`) => un nouvel essai sans lui, une seule fois par paramètre. `onRejected`
 * reçoit chaque paramètre retiré (note de journal ; l'appelant cesse de l'envoyer pour la suite du run).
 */
export async function generateWithSamplingRetry<P extends SamplingParams, R>(params: P, run: (params: P) => PromiseLike<R>, onRejected: (param: keyof SamplingSupport) => void): Promise<R> {
  let current = params;
  const retried = new Set<keyof SamplingSupport>();
  for (;;) {
    try {
      return await run(current);
    } catch (error) {
      const text = badRequestText(error);
      if (text === null) throw error;
      const named = samplingParamsRejected(text, { temperature: current.temperature, top_p: current.topP }).filter((p) => !retried.has(p));
      if (named.length === 0) throw error;
      const next = { ...current };
      for (const param of named) {
        retried.add(param);
        delete next[param === 'top_p' ? 'topP' : 'temperature'];
        onRejected(param);
      }
      current = next;
    }
  }
}
