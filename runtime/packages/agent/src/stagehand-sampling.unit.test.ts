// SPDX-License-Identifier: AGPL-3.0-only
import type { CapabilityProfile } from '@runtime/llm';
import { describe, expect, test } from 'vitest';
import { adaptSampling } from './stagehand-sampling.js';

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
