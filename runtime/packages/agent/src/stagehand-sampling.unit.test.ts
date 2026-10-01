// SPDX-License-Identifier: AGPL-3.0-only
import type { CapabilityProfile } from '@runtime/llm';
import { describe, expect, test } from 'vitest';
import { adaptSampling, generateWithSamplingRetry } from './stagehand-sampling.js';

const profile = (sampling?: CapabilityProfile['sampling']): CapabilityProfile => ({
  model: 'm',
  tools: true,
  tool_choice: ['auto'],
  structured_modes: [],
  structured: 'none',
  stream_tools: null,
  stream_usage: null,
  cache: false,
  reasoning_field: null,
  probed_at: '',
  probe_tokens: 0,
  notes: [],
  ...(sampling === undefined ? {} : { sampling }),
});

describe('adaptSampling : le moteur Stagehand passe par le même profil que le LlmClient (D-42)', () => {
  test('claude-opus-4-8 compatible OpenAI : temperature et top_p retirés, signalés', () => {
    const out = adaptSampling(profile({ temperature: false, top_p: false }), { temperature: 0, topP: 0.9 });
    expect(out.temperature).toBeUndefined();
    expect(out.topP).toBeUndefined();
    expect(out.dropped).toEqual(['temperature', 'top_p']);
  });

  test('température seule refusée : top_p conservé', () => {
    expect(adaptSampling(profile({ temperature: false, top_p: true }), { temperature: 0, topP: 0.9 })).toEqual({ topP: 0.9, dropped: ['temperature'] });
  });

  test('profil absent, sans mesure, ou paramètres acceptés : inchangé', () => {
    expect(adaptSampling(undefined, { temperature: 0 })).toEqual({ temperature: 0, dropped: [] });
    expect(adaptSampling(profile(), { temperature: 0, topP: 0.5 })).toEqual({ temperature: 0, topP: 0.5, dropped: [] });
    expect(adaptSampling(profile({ temperature: true, top_p: true }), { temperature: 0 })).toEqual({ temperature: 0, dropped: [] });
  });

  test('aucun paramètre fourni : rien à retirer', () => {
    expect(adaptSampling(profile({ temperature: false, top_p: false }), {})).toEqual({ dropped: [] });
  });
});

describe('generateWithSamplingRetry : repli sans profil sondé (400 qui nomme le paramètre)', () => {
  /** Forme d'une APICallError de l'AI SDK (statusCode, message, responseBody). */
  const apiError = (param: string) =>
    Object.assign(new Error(`\`${param}\` is deprecated for this model.`), { statusCode: 400, responseBody: `{"error":{"message":"\`${param}\` is deprecated for this model."}}` });

  test('400 sur temperature : un nouvel essai sans temperature, signalé une fois', async () => {
    const sent: object[] = [];
    const rejected: string[] = [];
    const out = await generateWithSamplingRetry({ temperature: 0, prompt: 'p' }, async (p) => {
      sent.push(p);
      if ('temperature' in p && p.temperature !== undefined) throw apiError('temperature');
      return 'ok';
    }, (param) => void rejected.push(param));
    expect(out).toBe('ok');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ prompt: 'p' });
    expect(rejected).toEqual(['temperature']);
  });

  test('temperature puis topP refusés : un essai par paramètre, pas plus', async () => {
    const sent: object[] = [];
    const out = await generateWithSamplingRetry({ temperature: 0, topP: 0.9 }, async (p) => {
      sent.push(p);
      if (p.temperature !== undefined) throw apiError('temperature');
      if (p.topP !== undefined) throw apiError('top_p');
      return 'ok';
    }, () => undefined);
    expect(out).toBe('ok');
    expect(sent).toEqual([{ temperature: 0, topP: 0.9 }, { topP: 0.9 }, {}]);
  });

  test('autre erreur, 400 sans paramètre nommé, ou paramètre non envoyé : propagée sans nouvel essai', async () => {
    let calls = 0;
    const fail = (error: Error) => generateWithSamplingRetry({ topP: 0.9 }, async () => {
      calls += 1;
      throw error;
    }, () => undefined);
    await expect(fail(apiError('temperature'))).rejects.toThrow('temperature');
    await expect(fail(Object.assign(new Error('bad'), { statusCode: 400 }))).rejects.toThrow('bad');
    await expect(fail(Object.assign(new Error('`top_p` overloaded'), { statusCode: 503 }))).rejects.toThrow('overloaded');
    expect(calls).toBe(3);
  });
});
