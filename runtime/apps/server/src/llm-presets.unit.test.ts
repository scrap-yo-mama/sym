// SPDX-License-Identifier: AGPL-3.0-only
// Préréglages de fournisseurs LLM : le serveur accepte les mêmes valeurs que le contrat OpenAPI (UX-01).
import { expect, test } from 'vitest';
import { SPECIFIED_OPENAPI_JSON } from './generated/openapi.js';
import { LLM_PRESETS } from './routes/settings.js';

const NEW_PRESETS = ['anthropic', 'gemini', 'mistral', 'groq'];

test('le serveur accepte le préréglage anthropic et les autres fournisseurs compatibles OpenAI', () => {
  for (const preset of NEW_PRESETS) expect(LLM_PRESETS).toContain(preset);
  expect(LLM_PRESETS).toContain('custom');
});

test('la liste du serveur est celle du contrat OpenAPI', () => {
  const spec = JSON.parse(SPECIFIED_OPENAPI_JSON) as { components: { schemas: { LlmPreset: { enum: string[] } } } };
  expect([...spec.components.schemas.LlmPreset.enum].sort()).toEqual([...LLM_PRESETS].sort());
});
