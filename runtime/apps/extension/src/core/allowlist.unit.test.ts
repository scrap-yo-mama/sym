// SPDX-License-Identifier: AGPL-3.0-only
// assert_cdp_allowlist (07 § 3) : contrôle statique de CI. Seules les méthodes CDP de la liste blanche figée figurent
// dans le code de l'extension, dans le noyau du tunnel qu'elle embarque ET dans le paquet construit ; aucune méthode
// `Runtime.*` (`evaluate`, `callFunctionOn`) ni `Emulation.*`. `chrome.debugger.sendCommand` n'est appelé qu'à un
// endroit, après le contrôle de la liste.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CDP_ALLOWED_EVENTS, CDP_ALLOWLIST, CDP_ALLOWLIST_VERSION } from './allowlist.ts';

/** Méthode de la liste, ou événement lu en lecture seule. */
const allowed = (m: string) => Object.hasOwn(CDP_ALLOWLIST, m) || CDP_ALLOWED_EVENTS.includes(m);

const SRC = new URL('..', import.meta.url).pathname;
const CORE_TUNNEL = new URL('../../../../packages/core/src/tunnel/', import.meta.url).pathname;
const CORE_AGENT = new URL('../../../../packages/core/src/agent/', import.meta.url).pathname;
const BUNDLE = new URL('../../dist/chrome-mv3/', import.meta.url).pathname;

/** Domaines du protocole CDP (version 1.3 et domaines expérimentaux courants). */
const CDP_DOMAINS = [
  'Accessibility', 'Animation', 'Audits', 'Autofill', 'BackgroundService', 'BluetoothEmulation', 'Browser', 'CSS', 'CacheStorage', 'Cast',
  'Console', 'DOM', 'DOMDebugger', 'DOMSnapshot', 'DOMStorage', 'Database', 'Debugger', 'DeviceAccess', 'DeviceOrientation', 'Emulation',
  'EventBreakpoints', 'Extensions', 'FedCm', 'Fetch', 'FileSystem', 'HeadlessExperimental', 'HeapProfiler', 'IO', 'IndexedDB', 'Input',
  'Inspector', 'LayerTree', 'Log', 'Media', 'Memory', 'Network', 'Overlay', 'PWA', 'Page', 'Performance', 'PerformanceTimeline', 'Preload',
  'Profiler', 'Runtime', 'Schema', 'Security', 'ServiceWorker', 'Storage', 'SystemInfo', 'Target', 'Tethering', 'Tracing', 'WebAudio', 'WebAuthn',
];
const METHOD = new RegExp(`['"\`](${CDP_DOMAINS.join('|')})\\.([a-z][A-Za-z]+)['"\`]`, 'g');

function files(dir: string, keep: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name), keep) : keep(join(dir, e.name)) ? [join(dir, e.name)] : []));
}

/** Code sans commentaires (les commentaires citent les méthodes interdites qu'ils décrivent). */
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function methodsIn(sources: readonly string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of sources) {
    for (const m of code(f).matchAll(METHOD)) {
      const method = `${m[1]}.${m[2]}`;
      found.set(method, [...(found.get(method) ?? []), f]);
    }
  }
  return found;
}

describe('assert_cdp_allowlist', () => {
  test('liste figée et versionnée : Page, Input, DOM, DOMSnapshot, Accessibility, Network (lecture seule)', () => {
    expect(CDP_ALLOWLIST_VERSION).toBe(1);
    expect(CDP_ALLOWED_EVENTS).toEqual(['Network.responseReceived']);
    expect(Object.keys(CDP_ALLOWLIST).sort()).toMatchSnapshot();
  });

  test('code de l’extension et noyau embarqué : seules des méthodes de la liste', () => {
    const sources = [
      ...files(SRC, (f) => /\.(ts|vue)$/.test(f) && !f.endsWith('.test.ts')),
      ...files(CORE_TUNNEL, (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')),
      ...files(CORE_AGENT, (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')),
    ];
    const used = methodsIn(sources);
    expect(used.size).toBeGreaterThan(5);
    const outside = [...used.keys()].filter((m) => !allowed(m));
    expect(outside).toEqual([]);
  });

  test('paquet construit (dist) : aucune méthode hors liste, ni Runtime.evaluate, ni callFunctionOn, ni Emulation', () => {
    const bundle = files(BUNDLE, (f) => f.endsWith('.js'));
    if (bundle.length === 0) return; // paquet pas encore construit (test:fast) ; la CI construit avant les tests
    const used = methodsIn(bundle);
    expect([...used.keys()].filter((m) => !allowed(m))).toEqual([]);
    const text = bundle.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(text).not.toMatch(/Runtime\.evaluate|Runtime\.callFunctionOn|Emulation\.[a-z]/);
  });

  test('chrome.debugger.sendCommand : un seul appel, après le contrôle de la liste blanche', () => {
    const sources = files(SRC, (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const callers = sources.filter((f) => /debugger\.sendCommand\(/.test(code(f)));
    expect(callers.map((f) => f.slice(SRC.length))).toEqual(['platform/chrome-api.ts']);
    const src = code(join(SRC, 'platform/chrome-api.ts'));
    expect(src.match(/debugger\.sendCommand\(/g)).toHaveLength(1);
    const send = src.slice(src.indexOf('send: async (tabId, method, params)'));
    expect(send.indexOf('checkCdpCommand(method, params)')).toBeGreaterThan(-1);
    expect(send.indexOf('checkCdpCommand(method, params)')).toBeLessThan(send.indexOf('debugger.sendCommand('));
  });

  test('chrome.scripting.executeScript n’exécute que des fonctions du paquet (aucune chaîne, aucun fichier distant)', () => {
    const src = code(join(SRC, 'platform/chrome-api.ts'));
    const calls = [...src.matchAll(/executeScript\(\{([\s\S]*?)\}\);/g)].map((m) => m[1]!);
    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(c).toMatch(/func: (pageFetchInPage|inspectPage)\b/);
      expect(c).not.toMatch(/files:|code:/);
    }
  });
});
