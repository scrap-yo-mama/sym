// SPDX-License-Identifier: AGPL-3.0-only
import { BROWSER_ENGINE } from '@sym/contracts/browser';
import { expect, test } from 'vitest';
import { describeRole, installedPlaywrightVersion, ROLE } from './engine.js';

test('nœud (squelette) : playwright-core installé = version du contrat (1.63.0)', () => {
  expect(ROLE).toBe('node');
  expect(BROWSER_ENGINE.playwright).toBe('1.63.0');
  expect(installedPlaywrightVersion()).toBe(BROWSER_ENGINE.playwright);
  expect(describeRole()).toContain('Playwright 1.63.0');
});
