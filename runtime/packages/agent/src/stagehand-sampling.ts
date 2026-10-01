// SPDX-License-Identifier: AGPL-3.0-only
// Échantillonnage du moteur Stagehand : il appelle le fournisseur par l'AI SDK, hors du LlmClient, donc hors de son retrait de
// paramètres (client.ts). Même règle, même profil sondé (`withoutUnsupportedSampling`) : un paramètre que le modèle refuse
// (claude-opus-4-8 compatible OpenAI : 400 sur `temperature` et `top_p`) n'est jamais envoyé.
import { withoutUnsupportedSampling, type CapabilityProfile, type SamplingSupport } from '@runtime/llm';

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
