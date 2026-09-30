import { describe, expect, test } from 'vitest';
import { computeUsage, UsageMeter, type ModelPrice } from './usage.js';

const price: ModelPrice = { in: 1, in_cached: 0.1, in_cache_write: 1.25, out: 4 };

describe('comptage tokens et coût (INV4)', () => {
  test('cache et raisonnement comptés d\'après l\'usage renvoyé', () => {
    const u = computeUsage({
      raw: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 300 } },
      price,
      requestChars: 0,
      responseChars: 0,
    });
    expect(u).toMatchObject({ tokens_in: 1000, tokens_cached: 600, tokens_cache_write: 100, tokens_out: 500, tokens_reasoning: 300, usage_estimated: false, cost_source: 'price' });
    // (300*1 + 600*0.1 + 100*1.25 + 500*4) / 1e6
    expect(u.cost_usd).toBeCloseTo((300 + 60 + 125 + 2000) / 1e6, 10);
  });

  test('usage.cost du fournisseur (OpenRouter) fait foi', () => {
    const u = computeUsage({ raw: { prompt_tokens: 10, completion_tokens: 10, cost: 0.0042 }, price, requestChars: 0, responseChars: 0 });
    expect(u).toMatchObject({ cost_usd: 0.0042, cost_source: 'provider' });
  });

  test('estimated_cost (DeepInfra) : repli faute de prix, le prix configuré prime', () => {
    const raw = { prompt_tokens: 1_000_000, completion_tokens: 0, estimated_cost: 0.0005 };
    expect(computeUsage({ raw, price: undefined, requestChars: 0, responseChars: 0 })).toMatchObject({ cost_usd: 0.0005, cost_source: 'provider_estimate' });
    expect(computeUsage({ raw, price, requestChars: 0, responseChars: 0 })).toMatchObject({ cost_usd: 1, cost_source: 'price' });
  });

  test('prix absent : coût null avec avertissement, jamais 0', () => {
    const u = computeUsage({ raw: { prompt_tokens: 10, completion_tokens: 10 }, price: undefined, requestChars: 0, responseChars: 0 });
    expect(u.cost_usd).toBeNull();
    expect(u.warnings).toContain('price_missing');
  });

  test('usage absent : estimation (caractères / 4) signalée par usage_estimated', () => {
    const u = computeUsage({ raw: null, price, requestChars: 400, responseChars: 80 });
    expect(u).toMatchObject({ tokens_in: 100, tokens_out: 20, usage_estimated: true });
    expect(u.warnings).toContain('usage_estimated');
  });

  test('fenêtre tarifaire : facteur appliqué dans la fenêtre UTC, y compris à cheval sur minuit', () => {
    const p: ModelPrice = { in: 1, out: 1, windows: [{ start_utc: '16:30', end_utc: '00:30', factor: 0.5 }] };
    const raw = { prompt_tokens: 1_000_000, completion_tokens: 0 };
    const at = (iso: string) => computeUsage({ raw, price: p, requestChars: 0, responseChars: 0, at: new Date(iso) }).cost_usd;
    expect(at('2026-10-01T17:00:00Z')).toBe(0.5);
    expect(at('2026-10-01T00:10:00Z')).toBe(0.5);
    expect(at('2026-10-01T12:00:00Z')).toBe(1);
  });

  test('cumul par run : coût null dès qu\'un appel n\'a pas de prix', () => {
    const meter = new UsageMeter();
    meter.add(computeUsage({ raw: { prompt_tokens: 1_000_000, completion_tokens: 0 }, price, requestChars: 0, responseChars: 0 }));
    expect(meter.snapshot()).toMatchObject({ calls: 1, cost_usd: 1, unpriced_calls: 0 });
    meter.add(computeUsage({ raw: { prompt_tokens: 5, completion_tokens: 5 }, price: undefined, requestChars: 0, responseChars: 0 }));
    const snap = meter.snapshot();
    expect(snap).toMatchObject({ calls: 2, cost_usd: null, cost_usd_known: 1, unpriced_calls: 1, tokens_in: 1_000_005 });
  });
});
