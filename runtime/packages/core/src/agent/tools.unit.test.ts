// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from 'vitest';
import { AGENT_TOOLS, isAgentTool } from './tools.js';

test('outils de l’agent : liste fermée et figée (08 §4)', () => {
  expect([...AGENT_TOOLS]).toEqual(['navigate', 'click', 'type', 'scroll', 'wait', 'snapshot', 'extract', 'finish']);
  expect(Object.isFrozen(AGENT_TOOLS)).toBe(true);
  for (const forbidden of ['shell', 'exec', 'install', 'approve_all', 'set_task', 'evaluate', 'solve_captcha']) expect(isAgentTool(forbidden)).toBe(false);
  expect(isAgentTool('click')).toBe(true);
});
