// SPDX-License-Identifier: AGPL-3.0-only
// Identité du moteur embarqué (17 §5, décision du 2026-10-01) : version de Chromium et plateforme réelle, dont se déduit
// le User-Agent réel (`engineUserAgent`, @runtime/core/access). Deux sources, la même valeur sur une image saine :
// - `browserEngineIdentity(browser)` : la version lue sur `browser.version()` du Chromium qui va servir (contextes de run) ;
// - `installedEngineIdentity()` : la version de Chromium épinglée par le Playwright installé (`browsers.json` du paquet),
//   pour ce qui n'a pas de navigateur sous la main (client HTTP E1, `--user-agent` du Chromium
//   agentique). Un test (tests/browser/engine-user-agent.security.test.ts) vérifie qu'elles coïncident avec le vrai moteur.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { EngineUserAgentError, type EngineIdentity } from '@runtime/core/access';
import type { Browser } from 'playwright-core';

/** Moteur du navigateur ouvert : sa version (`browser.version()`) et la plateforme réelle du worker. */
export function browserEngineIdentity(browser: Pick<Browser, 'version'>): EngineIdentity {
  return { version: browser.version(), platform: process.platform };
}

let installed: EngineIdentity | undefined;

/** Moteur épinglé par le Playwright installé : version de `browsers.json`, plateforme réelle. Lue une fois. */
export function installedEngineIdentity(): EngineIdentity {
  if (installed !== undefined) return installed;
  const manifest = join(dirname(createRequire(import.meta.url).resolve('playwright-core/package.json')), 'browsers.json');
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { browsers?: { name?: unknown; browserVersion?: unknown }[] };
  const version = parsed.browsers?.find((b) => b.name === 'chromium')?.browserVersion;
  if (typeof version !== 'string') throw new EngineUserAgentError('version de Chromium absente de browsers.json (Playwright)');
  installed = { version, platform: process.platform };
  return installed;
}
