// SPDX-License-Identifier: AGPL-3.0-only
// Garde-fous du bras B (revue 0.6a, point 3 ; exclusion X1) : Stagehand ne tourne qu'en local, sans API Browserbase,
// sans session Browserbase ni résolution de captcha, dans un environnement sans clé Browserbase ni Brave.
import { describe, expect, it } from 'vitest';
import { assertStagehandLocalOnly, forbiddenEnvPresent } from './guards.ts';

const LOCAL = { env: 'LOCAL', disableAPI: true, localBrowserLaunchOptions: { cdpUrl: 'ws://127.0.0.1:9222/x' } };

describe('environnement transmis à Stagehand', () => {
  it('BRAVE_API_KEY et les variables Browserbase sont détectées ; un environnement nettoyé passe', () => {
    expect(forbiddenEnvPresent({ BRAVE_API_KEY: 'zz_test', BROWSERBASE_API_KEY: 'zz_test', PATH: '/bin' })).toEqual(['BROWSERBASE_API_KEY', 'BRAVE_API_KEY']);
    expect(forbiddenEnvPresent({ PATH: '/bin' })).toEqual([]);
  });
});

describe('assertStagehandLocalOnly', () => {
  it('accepte la configuration du spike (LOCAL, disableAPI, cdpUrl)', () => {
    expect(() => assertStagehandLocalOnly(LOCAL, {})).not.toThrow();
    expect(() => assertStagehandLocalOnly({ ...LOCAL, waitForCaptchaSolves: false }, {})).not.toThrow();
  });
  it('refuse env BROWSERBASE et l\'absence de disableAPI', () => {
    expect(() => assertStagehandLocalOnly({ ...LOCAL, env: 'BROWSERBASE' }, {})).toThrow(/env/);
    expect(() => assertStagehandLocalOnly({ env: 'LOCAL' }, {})).toThrow(/disableAPI/);
  });
  it('refuse toute option de session Browserbase ou de résolution de captcha (X1)', () => {
    for (const extra of [
      { browserbaseSessionCreateParams: {} },
      { browserbaseSessionID: 'zz_test' },
      { apiKey: 'zz_test' },
      { projectId: 'zz_test' },
      { waitForCaptchaSolves: true },
      { solveCaptchas: true },
    ]) {
      expect(() => assertStagehandLocalOnly({ ...LOCAL, ...extra }, {}), JSON.stringify(extra)).toThrow(/interdite/);
    }
  });
  it('refuse un environnement qui porte une clé Browserbase ou Brave', () => {
    expect(() => assertStagehandLocalOnly(LOCAL, { BRAVE_API_KEY: 'zz_test' })).toThrow(/BRAVE_API_KEY/);
    expect(() => assertStagehandLocalOnly(LOCAL, { BROWSERBASE_PROJECT_ID: 'zz_test' })).toThrow(/BROWSERBASE_PROJECT_ID/);
  });
});
