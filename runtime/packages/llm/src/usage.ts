// SPDX-License-Identifier: AGPL-3.0-only
// Comptage tokens et coût (INV4) : d'après l'usage renvoyé, cache et raisonnement compris ; prix absent => null, jamais 0.
import type { ChatMessage, RawUsage } from './types.js';

/** Fenêtre tarifaire (ex. heures creuses) : le coût calculé est multiplié par `factor` si l'appel tombe dedans (heures UTC `HH:MM`, fin exclue). */
export interface PriceWindow {
  start_utc: string;
  end_utc: string;
  factor: number;
}

/** Prix en USD par million de jetons : `{in, in_cached, in_cache_write, out, windows[]}` (08 §1). */
export interface ModelPrice {
  in: number;
  in_cached?: number;
  in_cache_write?: number;
  out: number;
  windows?: PriceWindow[];
}

export interface CallUsage {
  tokens_in: number;
  tokens_cached: number;
  tokens_cache_write: number;
  tokens_out: number;
  tokens_reasoning: number;
  /** Vrai si le fournisseur n'a pas rendu d'usage exploitable : les valeurs sont une estimation (caractères / 4). */
  usage_estimated: boolean;
  /** Coût de l'appel en USD ; null si le prix est inconnu (jamais 0). */
  cost_usd: number | null;
  cost_source: 'provider' | 'price' | 'provider_estimate' | 'unknown';
  warnings: string[];
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

const minutes = (hhmm: string): number => {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

function windowFactor(price: ModelPrice, at: Date): number {
  const now = at.getUTCHours() * 60 + at.getUTCMinutes();
  for (const w of price.windows ?? []) {
    const start = minutes(w.start_utc);
    const end = minutes(w.end_utc);
    const inside = start <= end ? now >= start && now < end : now >= start || now < end;
    if (inside) return w.factor;
  }
  return 1;
}

export function charsOf(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') total += m.content.length;
    else if (Array.isArray(m.content)) for (const p of m.content) total += typeof p.text === 'string' ? p.text.length : 0;
    for (const tc of m.tool_calls ?? []) total += tc.function.arguments.length + tc.function.name.length;
  }
  return total;
}

/**
 * Coût PRÉVU d'un appel, connu avant l'envoi (constat UX-32 : un essai à 0,534 $ pour un plafond de 0,50 $) : entrée estimée
 * sur la taille de la requête (caractères / 4, comme l'estimation sans usage), sortie attendue en jetons (celle du dernier
 * appel, 0 pour le premier) ; borne basse, au prix frais (sans remise de cache). null sans prix (le coût ne se prévoit pas).
 */
export function estimateCallUsd(input: { readonly requestChars: number; readonly outputTokens: number; readonly price: ModelPrice | undefined; readonly at?: Date }): number | null {
  if (input.price === undefined) return null;
  const raw = { prompt_tokens: Math.ceil(Math.max(0, input.requestChars) / 4), completion_tokens: Math.max(0, input.outputTokens) } as RawUsage;
  return computeUsage({ raw, price: input.price, requestChars: input.requestChars, responseChars: 0, ...(input.at === undefined ? {} : { at: input.at }) }).cost_usd;
}

export interface UsageInput {
  raw: RawUsage | null;
  price: ModelPrice | undefined;
  /** Pour l'estimation quand l'usage manque. */
  requestChars: number;
  responseChars: number;
  at?: Date;
}

export function computeUsage(input: UsageInput): CallUsage {
  const { raw, price } = input;
  const warnings: string[] = [];
  const promptTokens = num(raw?.prompt_tokens);
  const completionTokens = num(raw?.completion_tokens);
  const estimated = promptTokens === undefined || completionTokens === undefined;
  if (estimated) warnings.push('usage_estimated');

  const tokens_in = promptTokens ?? Math.ceil(input.requestChars / 4);
  const tokens_out = completionTokens ?? Math.ceil(input.responseChars / 4);
  const cached =
    num(raw?.prompt_tokens_details?.cached_tokens) ?? num(raw?.prompt_cache_hit_tokens) ?? 0;
  const tokens_cached = Math.min(cached, tokens_in);
  const tokens_cache_write = Math.min(num(raw?.prompt_tokens_details?.cache_write_tokens) ?? 0, tokens_in - tokens_cached);
  const tokens_reasoning = Math.min(num(raw?.completion_tokens_details?.reasoning_tokens) ?? 0, tokens_out);

  let cost_usd: number | null = null;
  let cost_source: CallUsage['cost_source'] = 'unknown';
  const providerCost = num(raw?.cost);
  if (providerCost !== undefined) {
    // OpenRouter : `usage.cost` fait foi.
    cost_usd = providerCost;
    cost_source = 'provider';
  } else if (price !== undefined) {
    const fresh = tokens_in - tokens_cached - tokens_cache_write;
    const perMillion =
      fresh * price.in +
      tokens_cached * (price.in_cached ?? price.in) +
      tokens_cache_write * (price.in_cache_write ?? price.in) +
      tokens_out * price.out;
    cost_usd = (perMillion / 1_000_000) * windowFactor(price, input.at ?? new Date());
    cost_source = 'price';
  } else if (num(raw?.estimated_cost) !== undefined) {
    // DeepInfra : `usage.estimated_cost`, utilisé seulement faute de prix configuré.
    cost_usd = num(raw?.estimated_cost) ?? null;
    cost_source = 'provider_estimate';
  } else {
    warnings.push('price_missing');
  }
  return { tokens_in, tokens_cached, tokens_cache_write, tokens_out, tokens_reasoning, usage_estimated: estimated, cost_usd, cost_source, warnings };
}

export interface RunUsage {
  calls: number;
  tokens_in: number;
  tokens_cached: number;
  tokens_out: number;
  tokens_reasoning: number;
  usage_estimated: boolean;
  /** Somme des coûts connus. */
  cost_usd_known: number;
  /** Null dès qu'un appel n'a pas de prix : jamais 0 par défaut. */
  cost_usd: number | null;
  unpriced_calls: number;
  warnings: string[];
}

/** Cumul par run : les tentatives échouées facturées y sont imputées. */
export class UsageMeter {
  #calls: CallUsage[] = [];

  add(usage: CallUsage): void {
    this.#calls.push(usage);
  }

  snapshot(): RunUsage {
    const out: RunUsage = {
      calls: this.#calls.length,
      tokens_in: 0,
      tokens_cached: 0,
      tokens_out: 0,
      tokens_reasoning: 0,
      usage_estimated: false,
      cost_usd_known: 0,
      cost_usd: 0,
      unpriced_calls: 0,
      warnings: [],
    };
    const warnings = new Set<string>();
    for (const u of this.#calls) {
      out.tokens_in += u.tokens_in;
      out.tokens_cached += u.tokens_cached;
      out.tokens_out += u.tokens_out;
      out.tokens_reasoning += u.tokens_reasoning;
      out.usage_estimated ||= u.usage_estimated;
      if (u.cost_usd === null) out.unpriced_calls += 1;
      else out.cost_usd_known += u.cost_usd;
      for (const w of u.warnings) warnings.add(w);
    }
    out.cost_usd = out.unpriced_calls > 0 ? null : out.cost_usd_known;
    out.warnings = [...warnings];
    return out;
  }
}
