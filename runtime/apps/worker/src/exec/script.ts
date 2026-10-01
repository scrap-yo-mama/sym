// SPDX-License-Identifier: AGPL-3.0-only
// E3 en script (`script_ref`) : le code généré ne s'exécute QUE dans le bac à sable (INV7, tâche 1.5) et ne voit que des
// ponts. Interface `SandboxEngine { run(code, bridges, limits) }` de 08 §3 ; les ponts sont des fonctions, valeurs en
// chaînes JSON, chaque appel validé côté hôte (forme, taille, domaine de l'API). Sans moteur branché, la stratégie
// échoue (`code_error`, `sandbox_unavailable`) : jamais d'exécution hors bac à sable.
import type { NetworkSession, SsrfGuard } from '@runtime/core/net';
import { guardedGoto } from '@runtime/core/net';
import type { Page } from 'playwright-core';
import { hostAllowed } from '../browser/run-context.js';

export type SandboxLimits = { readonly timeoutMs: number; readonly memoryMb: number };
/** Pont : une fonction de l'hôte, argument et résultat en JSON (jamais un objet de l'hôte). */
type SandboxBridge = (argsJson: string) => Promise<string>;
type SandboxBridges = Readonly<Record<string, SandboxBridge>>;
type SandboxOutcome = { readonly ok: true } | { readonly ok: false; readonly error: 'timeout' | 'memory' | 'code_error' | 'killed' };

interface SandboxEngine {
  run(code: string, bridges: SandboxBridges, limits: SandboxLimits): Promise<SandboxOutcome>;
}

/** Branchement du bac à sable (1.5) : moteur et lecture du script référencé par la version de stratégie. */
export type ScriptPort = {
  readonly engine: SandboxEngine;
  loadScript(scriptRef: string): Promise<string>;
};

export const SCRIPT_DEFAULT_LIMITS: SandboxLimits = Object.freeze({ timeoutMs: 60_000, memoryMb: 128 });
const MAX_ARG_BYTES = 64 * 1024;
const MAX_LOGS = 200;

export class BridgeError extends Error {
  override name = 'BridgeError';
}

type Json = Record<string, unknown>;

function parseArgs(raw: string): Json {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_ARG_BYTES) throw new BridgeError('arguments de pont trop grands');
  const v: unknown = JSON.parse(raw);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new BridgeError('arguments de pont : objet JSON attendu');
  return v as Json;
}

const str = (v: unknown, name: string, max = 2_000): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new BridgeError(`argument ${name} invalide`);
  return v;
};

export type ScriptBridgeOptions = {
  readonly page: Page;
  readonly guard: SsrfGuard;
  /** Domaines de l'API : `ctx.fetch` et `ctx.page.goto` sont refusés ailleurs (08 §3). */
  readonly allowedHosts: readonly string[];
  readonly session: Pick<NetworkSession, 'fetch'>;
  readonly maxItems: number;
  readonly maxResponseBytes: number;
};

export type ScriptBridgeSet = { readonly bridges: SandboxBridges; readonly items: unknown[]; readonly logs: string[] };

/** Ponts d'E3 : `fetch`, sous-ensemble de lecture de `page`, `emit`, `log`. Liste fermée. */
export function createScriptBridges(options: ScriptBridgeOptions): ScriptBridgeSet {
  const items: unknown[] = [];
  const logs: string[] = [];
  const checkHost = (url: string) => {
    if (!hostAllowed(url, options.allowedHosts)) throw new BridgeError('domaine hors de l’API');
  };
  const bridges: Record<string, SandboxBridge> = {
    fetch: async (raw) => {
      const a = parseArgs(raw);
      const url = str(a['url'], 'url');
      checkHost(url);
      const method = a['method'] === 'POST' ? 'POST' : 'GET';
      const body = a['body'] === undefined ? undefined : str(a['body'], 'body', MAX_ARG_BYTES);
      const response = await options.session.fetch(url, { method, ...(body === undefined ? {} : { body }) });
      const text = await response.text();
      if (Buffer.byteLength(text) > options.maxResponseBytes) throw new BridgeError('réponse trop grande');
      return JSON.stringify({ status: response.status, body: text });
    },
    'page.goto': async (raw) => {
      const url = str(parseArgs(raw)['url'], 'url');
      checkHost(url);
      const response = await guardedGoto(options.page, url, options.guard, { waitUntil: 'load' as const });
      return JSON.stringify({ status: response?.status() ?? 0 });
    },
    'page.waitForSelector': async (raw) => {
      const a = parseArgs(raw);
      const timeout = typeof a['timeoutMs'] === 'number' ? Math.min(Math.max(a['timeoutMs'], 0), 30_000) : 10_000;
      await options.page.waitForSelector(str(a['selector'], 'selector', 300), { state: 'attached', timeout });
      return '{}';
    },
    'page.content': async () => {
      const html = await options.page.content();
      if (Buffer.byteLength(html) > options.maxResponseBytes) throw new BridgeError('page trop grande');
      return JSON.stringify({ html });
    },
    'page.textAll': async (raw) => {
      const selector = str(parseArgs(raw)['selector'], 'selector', 300);
      const texts = await options.page.locator(selector).allTextContents();
      return JSON.stringify({ texts: texts.slice(0, options.maxItems) });
    },
    emit: async (raw) => {
      if (items.length >= options.maxItems) throw new BridgeError('trop d’éléments émis');
      items.push(parseArgs(raw)['item']);
      return '{}';
    },
    log: async (raw) => {
      if (logs.length < MAX_LOGS) logs.push(str(parseArgs(raw)['message'], 'message', 1_000));
      return '{}';
    },
  };
  return { bridges: Object.freeze(bridges), items, logs };
}
