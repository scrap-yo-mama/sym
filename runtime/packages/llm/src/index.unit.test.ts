import { expect, test } from 'vitest';
import type { LlmTransport } from './index.js';

test('un transport minimal satisfait LlmTransport', async () => {
  const transport: LlmTransport = { complete: async (m) => `${m.length}` };
  expect(await transport.complete([{ role: 'user', content: 'x' }])).toBe('1');
});
