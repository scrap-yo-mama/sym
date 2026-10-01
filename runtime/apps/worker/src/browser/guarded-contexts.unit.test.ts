// SPDX-License-Identifier: AGPL-3.0-only
// assert_all_browser_contexts_guarded (INV11, correctif fix-inv11-agent) : aucun contexte ni aucune page Chromium de run
// ne s'ouvre sans la garde robots.txt de 1.11. Par construction :
// - `openRunContext` (run-context.ts) est le SEUL code du worker et du paquet agent qui crée un contexte (`newContext`)
//   ou une page (`newPage`) Playwright ; il pose toute la garde sans condition et exige `checkRequest` (type, puis refus à
//   l'exécution avant toute ouverture) ;
// - le Chromium dédié des essais agentiques (agent-browser.ts, seul `connectOverCDP`) passe par `openRunContext` en mode
//   `dedicated`, avec le `checkRequest` exigé de ses options, et coupe au lancement les mêmes fonctions qu'en 1.11 ;
// - les exceptions sont nommées et justifiées ci-dessous ; tout nouvel appel ailleurs fait échouer ce test.
// Sans Chromium : lecture des sources et faux navigateur.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Browser } from 'playwright-core';
import { describe, expect, test, vi } from 'vitest';
import { agentChromiumArgs, type AgentBrowserOptions } from './agent-browser.js';
import { INV11_DISABLED_FEATURES } from './launch.js';
import { openRunContext, type RunContextOptions } from './run-context.js';
import type { AgentFetchOptions, AgentOptions, HybridOptions } from '../exec/agent-executors.js';
import type { BrowserExecutorOptions } from '../exec/browser-executors.js';
import type { ScriptExecutorOptions } from '../exec/script-executor.js';

const runtime = new URL('../../../../', import.meta.url).pathname;
/** Sources de production qui pilotent Chromium : le worker et le paquet agent (Stagehand, canal Playwright). */
const ROOTS = ['apps/worker/src', 'packages/agent/src'];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.ts') && !/\.test\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Code sans commentaires (une mention dans un commentaire n'ouvre rien). */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** Appels qui créent un contexte, une page, ou se raccordent à un Chromium. */
const OPENERS: readonly { name: string; re: RegExp }[] = [
  { name: 'newContext', re: /\.newContext\(/g },
  { name: 'newPage', re: /\.newPage\(/g },
  { name: 'connectOverCDP', re: /connectOverCDP\(/g },
  { name: 'launchPersistentContext', re: /launchPersistentContext\(/g },
  { name: 'launchServer', re: /\.launchServer\(/g },
  { name: 'launch', re: /chromium\.launch\(/g },
  { name: 'connect', re: /chromium\.connect\(/g },
  { name: 'newAgentContext', re: /newAgentContext\(/g },
];

/**
 * Exceptions admises (fichier → appels). Toute autre occurrence est un chemin de run non gardé.
 * - run-context.ts : la fabrique gardée elle-même (`newContext` du contexte de run, `newPage` de la page du run) et
 *   `request.newContext` (APIRequestContext : hors Chromium, proxy d'egress imposé, robots.txt par la session réseau) ;
 * - pool.ts : lancement du Chromium partagé derrière un proxy FERMÉ (aucun contexte, aucune page) ;
 * - agent-browser.ts : raccordement au Chromium dédié, dont l'unique contexte passe par `openRunContext` (vérifié plus bas) ;
 * - stagehand-engine.ts : Stagehand pilote le Chromium dédié et prend sa page du run (`pages()[0]`) ; à défaut il en
 *   ouvrirait une, aussitôt fermée par la garde du contexte de run (requêtes coupées) ;
 * - playwright-channel.ts : `newAgentContext`, API du paquet sans robots.txt, jamais appelée par le worker (vérifié).
 * - quickjs-runner.ts : contexte d'une VM QuickJS du bac à sable (1.5), pas de Chromium.
 */
const ALLOWED: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'apps/worker/src/browser/run-context.ts': { newContext: 2, newPage: 2 },
  'apps/worker/src/browser/pool.ts': { launchServer: 1, connect: 1 },
  'apps/worker/src/browser/agent-browser.ts': { connectOverCDP: 1 },
  'packages/agent/src/stagehand-engine.ts': { newPage: 1 },
  'apps/worker/src/sandbox/quickjs-runner.ts': { newContext: 1 },
  'packages/agent/src/playwright-channel.ts': { newContext: 1, newAgentContext: 1 },
};

/** Vrai si la propriété `K` de `T` est exigée (ni optionnelle, ni `undefined`). */
type Required<T, K extends keyof T> = undefined extends T[K] ? false : Record<never, never> extends Pick<T, K> ? false : true;

describe('assert_all_browser_contexts_guarded — aucun contexte Chromium de run sans la garde robots.txt (INV11)', () => {
  test('seule la fabrique gardée crée un contexte ou une page ; toute autre ouverture est une exception nommée', () => {
    const found: Record<string, Record<string, number>> = {};
    for (const root of ROOTS) {
      for (const file of sources(join(runtime, root))) {
        const text = code(readFileSync(file, 'utf8'));
        for (const opener of OPENERS) {
          const n = text.match(opener.re)?.length ?? 0;
          if (n > 0) ((found[relative(runtime, file)] ??= {})[opener.name] = n);
        }
      }
    }
    expect(found).toEqual(ALLOWED);
  });

  test('le Chromium dédié des essais agentiques (E5-E6, Stagehand) ouvre son contexte de run par openRunContext, checkRequest exigé', () => {
    const text = code(readFileSync(join(runtime, 'apps/worker/src/browser/agent-browser.ts'), 'utf8'));
    expect(text).toMatch(/openRunContext\(browser, \{ dedicated: true, [^}]*checkRequest: options\.checkRequest[^}]*\}\)/);
    // La page du run est celle de la garde (aucune autre page n'est créée ni prise ici).
    expect(text).toMatch(/const page = run\.page;/);
    expect(text).not.toMatch(/context\.pages\(\)/);
  });

  test('checkRequest et le contrôle robots.txt sont exigés par le type, du contexte de run jusqu’aux exécuteurs E1-E6', () => {
    const exigences: true[] = [
      true satisfies Required<RunContextOptions, 'checkRequest'>,
      true satisfies Required<AgentBrowserOptions, 'checkRequest'>,
      true satisfies Required<BrowserExecutorOptions, 'access'>,
      true satisfies Required<ScriptExecutorOptions, 'robots'>,
      true satisfies Required<AgentFetchOptions, 'access'>,
      true satisfies Required<HybridOptions, 'access'>,
      true satisfies Required<AgentOptions, 'access'>,
    ];
    expect(exigences).toHaveLength(7);
  });

  test('échec fermé : openRunContext sans checkRequest refuse avant toute ouverture (ni contexte, ni session CDP)', async () => {
    const browser = { newContext: vi.fn(), newBrowserCDPSession: vi.fn(), contexts: vi.fn(() => []) };
    const options = { egressServer: 'http://127.0.0.1:1', allowedHosts: ['zz_test.localhost'] } as unknown as RunContextOptions;
    await expect(openRunContext(browser as unknown as Browser, options)).rejects.toThrow(/robots\.txt/);
    await expect(openRunContext(browser as unknown as Browser, { ...options, dedicated: true })).rejects.toThrow(/robots\.txt/);
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(browser.newBrowserCDPSession).not.toHaveBeenCalled();
    expect(browser.contexts).not.toHaveBeenCalled();
  });

  test('Chromium dédié : un userAgent passé à openRunContext est refusé avant toute ouverture (il relève du lancement)', async () => {
    const browser = { newContext: vi.fn(), newBrowserCDPSession: vi.fn(), contexts: vi.fn(() => []) };
    const options: RunContextOptions = { egressServer: 'http://127.0.0.1:1', allowedHosts: ['zz_test.localhost'], checkRequest: async () => true, dedicated: true, userAgent: 'zz-robot/1.0' };
    await expect(openRunContext(browser as unknown as Browser, options)).rejects.toThrow(/userAgent/);
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(browser.newBrowserCDPSession).not.toHaveBeenCalled();
    expect(browser.contexts).not.toHaveBeenCalled();
  });

  test('le Chromium dédié coupe au lancement les fonctions de 1.11 (prérendu, préchargement, WebSocketStream)', () => {
    const args = agentChromiumArgs('http://127.0.0.1:1', '/tmp/zz_test_profile', {});
    const disabled = args.filter((a) => a.startsWith('--disable-features='));
    // Un seul --disable-features (Chromium ne retient que le dernier) et il contient toute la liste INV11.
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.slice('--disable-features='.length).split(',')).toEqual(expect.arrayContaining([...INV11_DISABLED_FEATURES]));
  });
});
