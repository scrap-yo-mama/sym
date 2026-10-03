// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur BYO des niveaux N1 à N3 : fichier JSON HORS du dépôt (EVAL_LLM_CONFIG), clés lues dans des variables
// d'environnement nommées par le fichier, jamais écrites ni journalisées (INV8). N1 : le premier modèle (modèle par défaut) ;
// N2 : tous les modèles déclarés. Le même modèle tient les rôles `investigate`, `extract` et `repair`.
import { readFileSync } from 'node:fs';
import { Secret } from '@runtime/core';
import type { LlmConfig } from '@runtime/llm';

export interface EvalLlmFile {
  providers: { id: string; base_url: string; api_key_env: string; models: { id: string; price?: { in: number; out: number } }[] }[];
  models: { provider: string; model: string }[];
}

export interface ModelUnderTest {
  modelId: string;
  config: LlmConfig;
  /** Hôte du fournisseur : seule destination hors de l'instance permise au banc (réseau de l'étape limité au fournisseur). */
  providerHost: string;
}

export function modelsUnderTest(file: EvalLlmFile, env: Readonly<Record<string, string | undefined>>): ModelUnderTest[] {
  if (!Array.isArray(file.models) || file.models.length === 0) throw new Error('EVAL_LLM_CONFIG : au moins un modèle dans `models`');
  return file.models.map(({ provider, model }) => {
    const p = file.providers.find((x) => x.id === provider);
    if (p === undefined) throw new Error(`EVAL_LLM_CONFIG : fournisseur inconnu ${provider}`);
    const declared = p.models.find((m) => m.id === model);
    if (declared === undefined) throw new Error(`EVAL_LLM_CONFIG : modèle ${model} absent du fournisseur ${provider}`);
    const key = env[p.api_key_env];
    if (key === undefined || key === '') throw new Error(`EVAL_LLM_CONFIG : variable ${p.api_key_env} vide (clé du fournisseur ${provider})`);
    const role = { provider: p.id, model };
    return {
      modelId: model,
      providerHost: new URL(p.base_url).hostname,
      config: {
        providers: [{ id: p.id, baseUrl: p.base_url, apiKey: new Secret(key), models: [{ id: model, ...(declared.price === undefined ? {} : { price: declared.price }) }] }],
        roles: { investigate: role, extract: role, repair: role },
      },
    };
  });
}

export function readEvalLlmFile(path: string | undefined): EvalLlmFile {
  if (path === undefined || path === '') throw new Error('N1 à N3 : EVAL_LLM_CONFIG (fichier JSON hors du dépôt) requis, voir eval/README.md');
  return JSON.parse(readFileSync(path, 'utf8')) as EvalLlmFile;
}
