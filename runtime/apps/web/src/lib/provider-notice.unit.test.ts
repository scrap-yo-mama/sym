// SPDX-License-Identifier: AGPL-3.0-only
// Mention fournisseur (tâche 2.12, 19 §3, 08 §4 point 5) : les fournisseurs des rôles qui reçoivent des extraits de
// l'API, étendue à `judge` (s'il est activé), `reflect` et `embed` (option de la mémoire activée).
import { describe, expect, test } from 'vitest';
import { providersReceiving } from './provider-notice';

describe('mention fournisseur étendue à judge, reflect, embed', () => {
  test('rôles d’enquête toujours ; judge seulement activé ; reflect s’il est configuré ; embed seulement avec l’option', () => {
    const roles = {
      investigate: { provider: 'zai', model: 'glm' },
      extract: { provider: 'ollama', model: 'q' },
      judge: { provider: 'openrouter', model: 'j' },
      reflect: { provider: 'deepseek', model: 'r' },
      embed: { provider: 'voyage', model: 'e' },
    };
    expect(providersReceiving({ roles })).toEqual(['zai', 'ollama', 'deepseek']);
    expect(providersReceiving({ roles, judge: { enabled: true } })).toEqual(['zai', 'ollama', 'openrouter', 'deepseek']);
    expect(providersReceiving({ roles, judge: { enabled: true }, catalog_memory: { embeddings: true } })).toEqual(['zai', 'ollama', 'openrouter', 'deepseek', 'voyage']);
    expect(providersReceiving({ roles: { investigate: { provider: 'zai', model: 'a' }, repair: { provider: 'zai', model: 'b' } } })).toEqual(['zai']);
    expect(providersReceiving({})).toEqual([]);
  });
});
