// SPDX-License-Identifier: AGPL-3.0-only
// assert_all_browser_contexts_guarded (INV10, correctif fix-inv11-agent) : aucun contexte ni aucune page Chromium de run
// ne s'ouvre sans la garde des contextes de run (proxy d'egress, verrou de domaines à chaque saut, WebSocket, workers).
// Par construction :
// - `openRunContext` (run-context.ts) est le SEUL code du worker et du paquet agent qui crée un contexte (`newContext`)
//   ou une page (`newPage`) Playwright ; il pose toute la garde sans condition ;
// - le Chromium dédié des essais agentiques (agent-browser.ts, seul `connectOverCDP`) passe par `openRunContext` en mode
//   `dedicated`, et coupe au lancement les mêmes fonctions que le Chromium du pool ;
// - les exceptions sont nommées et justifiées ci-dessous ; tout nouvel appel ailleurs fait échouer ce test.
// Sans Chromium : lecture des sources et faux navigateur.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Browser } from 'playwright-core';
import { describe, expect, test, vi } from 'vitest';
import { agentChromiumArgs } from './agent-browser.js';
import { GUARD_DISABLED_FEATURES } from './launch.js';
import { openRunContext, type RunContextOptions } from './run-context.js';

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
 *   `request.newContext` (APIRequestContext : hors Chromium, proxy d'egress imposé) ;
 * - user-agent-override.ts : contexte-sonde vierge (lecture des indices clients du moteur, une fois par navigateur) : sa seule
 *   route sert l'URL de sonde (http://localhost/) et coupe tout le reste, aucune requête n'en sort ; ce n'est pas un contexte de run ;
 * - provider-local.ts : fournisseur `local` (tâche 4.1) : lancement du Chromium partagé derrière un proxy FERMÉ (aucun contexte,
 *   aucune page) et raccordement au Chromium dédié ;
 * - provider-cdp.ts : fournisseur `cdp` (tâche 4.7) : raccordement `connectOverCDP` au navigateur distant, qui n'ouvre ni contexte ni
 *   page ; le contexte du run est créé par `openRunContext`, comme pour tout fournisseur ;
 * - agent-browser.ts : le contexte du Chromium dédié passe par `openRunContext` (vérifié plus bas) ;
 * - stagehand-engine.ts : Stagehand pilote le Chromium dédié et prend sa page du run (`pages()[0]`) ; à défaut il en
 *   ouvrirait une, aussitôt fermée par la garde du contexte de run (requêtes coupées) ;
 * - playwright-channel.ts : `newAgentContext`, API du paquet, jamais appelée par le worker (vérifié).
 * - quickjs-runner.ts : contexte d'une VM QuickJS du bac à sable (1.5), pas de Chromium.
 */
const ALLOWED: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'apps/worker/src/browser/run-context.ts': { newContext: 2, newPage: 2 },
  'apps/worker/src/browser/user-agent-override.ts': { newContext: 1 },
  'apps/worker/src/browser/provider-local.ts': { launchServer: 1, connect: 1, connectOverCDP: 1 },
  'apps/worker/src/browser/provider-cdp.ts': { connectOverCDP: 1 },
  'packages/agent/src/stagehand-engine.ts': { newPage: 1 },
  'apps/worker/src/sandbox/quickjs-runner.ts': { newContext: 1 },
  'packages/agent/src/playwright-channel.ts': { newContext: 1, newAgentContext: 1 },
};

describe('assert_all_browser_contexts_guarded — aucun contexte Chromium de run sans la garde des contextes de run (INV10)', () => {
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

  test('le Chromium dédié des essais agentiques (E5-E6, Stagehand) ouvre son contexte de run par openRunContext', () => {
    const text = code(readFileSync(join(runtime, 'apps/worker/src/browser/agent-browser.ts'), 'utf8'));
    // Le contrôle passé à `openRunContext` relève les écritures lancées (requête initiale) avant tout verdict.
    expect(text).toMatch(/openRunContext\(browser, \{\s*dedicated: true,(?:(?!\}\);)[\s\S])*?checkRequest: async \(hop\) => \{[^}]*writes\.check \+= 1;/);
    // La page du run est celle de la garde (aucune autre page n'est créée ni prise ici).
    expect(text).toMatch(/const page = run\.page;/);
    expect(text).not.toMatch(/context\.pages\(\)/);
  });

  test('Chromium dédié : un userAgent passé à openRunContext est refusé avant toute ouverture (il relève du lancement)', async () => {
    const browser = { newContext: vi.fn(), newBrowserCDPSession: vi.fn(), contexts: vi.fn(() => []) };
    const options: RunContextOptions = { egressServer: 'http://127.0.0.1:1', allowedHosts: ['zz_test.localhost'], checkRequest: async () => true, dedicated: true, userAgent: 'zz-robot/1.0' };
    await expect(openRunContext(browser as unknown as Browser, options)).rejects.toThrow(/userAgent/);
    expect(browser.newContext).not.toHaveBeenCalled();
    expect(browser.newBrowserCDPSession).not.toHaveBeenCalled();
    expect(browser.contexts).not.toHaveBeenCalled();
  });

  test('le Chromium dédié coupe au lancement les fonctions que la garde ne voit pas (prérendu, préchargement, WebSocketStream)', () => {
    const args = agentChromiumArgs('http://127.0.0.1:1', '/tmp/zz_test_profile', 'zz-robot/1.0', {});
    const disabled = args.filter((a) => a.startsWith('--disable-features='));
    // Un seul --disable-features (Chromium ne retient que le dernier) et il contient toute la liste de la garde.
    expect(disabled).toHaveLength(1);
    expect(disabled[0]!.slice('--disable-features='.length).split(',')).toEqual(expect.arrayContaining([...GUARD_DISABLED_FEATURES]));
  });
});
