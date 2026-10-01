// SPDX-License-Identifier: AGPL-3.0-only
// Processus enfant du bac à sable (INV7, 08 §3). Lancé par `ProcessSandboxEngine` avec un environnement VIDE,
// `--no-node-snapshot` et le mode permission de Node (ceinture). Il n'ouvre ni réseau ni fichier : il héberge l'isolat
// et relaie les appels de ponts au parent par IPC, qui seul valide et agit. Tué par SIGKILL à la fin de chaque run.
// Fichier autonome : aucune importation relative à l'exécution (exécuté tel quel en .ts sous les tests, en .js en prod).
import type { ChildMessage, ParentMessage, RunMessage } from './protocol.js';

/** Code exécuté dans l'isolat avant le script : ponts `ctx`, `input`, globals retirés et pièges à violation. */
const GUEST_BOOTSTRAP = String.raw`(function (send, inputJson) {
  'use strict';
  const MAX_PENDING = 64;
  const pending = new Map();
  let seq = 0;
  class SandboxError extends Error {
    constructor(code) { super(code); this.name = 'SandboxError'; this.code = code; }
  }
  const toJson = (value, what) => {
    let out;
    try { out = JSON.stringify(value); } catch (e) { throw new TypeError(what + ' : valeur non sérialisable en JSON'); }
    if (typeof out !== 'string') throw new TypeError(what + ' : valeur non sérialisable en JSON');
    return out;
  };
  const text = (value) => {
    if (typeof value === 'string') return value;
    try { const s = JSON.stringify(value); return s === undefined ? String(value) : s; } catch (e) { return '[non sérialisable]'; }
  };
  const call = (bridge, payload) => new Promise((resolve, reject) => {
    if (pending.size >= MAX_PENDING) { reject(new SandboxError('bridge_quota')); return; }
    const id = ++seq;
    pending.set(id, { resolve, reject });
    send('call', id, bridge, payload);
  });
  const ctx = Object.freeze({
    fetch: async (url, init) => {
      const i = init === undefined || init === null ? {} : init;
      const request = {
        url: String(url),
        method: i.method === undefined ? 'GET' : String(i.method),
        headers: i.headers === undefined || i.headers === null ? {} : i.headers,
        body: i.body === undefined ? undefined : i.body,
      };
      const res = JSON.parse(await call('fetch', toJson(request, 'ctx.fetch')));
      const headers = Object.freeze(res.headers);
      return Object.freeze({
        status: res.status, ok: res.status >= 200 && res.status < 300, url: res.url, headers, truncated: res.truncated,
        text: async () => res.body,
        json: async () => JSON.parse(res.body),
      });
    },
    // ctx.page.* (E3, tâche 1.6) : chaque opération est une demande JSON au parent, qui seul tient la page Playwright.
    // evaluate envoie le TEXTE de la fonction : elle s'exécute dans la page (Chromium, proxy d'egress et verrou de
    // domaines), jamais dans l'hôte.
    page: (() => {
      const op = async (name, args) => JSON.parse(await call('page', toJson({ op: name, args: args }, 'ctx.page.' + name)));
      const timeoutOf = (o) => (o !== undefined && o !== null && o.timeout !== undefined ? Number(o.timeout) : undefined);
      return Object.freeze({
        goto: async (url) => op('goto', { url: String(url) }),
        url: async () => (await op('url', {})).url,
        waitForSelector: async (selector, options) => op('waitForSelector', { selector: String(selector), timeoutMs: timeoutOf(options) }),
        content: async () => (await op('content', {})).html,
        textAll: async (selector) => (await op('textAll', { selector: String(selector) })).texts,
        attrAll: async (selector, name) => (await op('attrAll', { selector: String(selector), name: String(name) })).values,
        click: async (selector, options) => op('click', { selector: String(selector), timeoutMs: timeoutOf(options) }),
        evaluate: async (fn, arg) => {
          const isFunction = typeof fn === 'function';
          const out = await op('evaluate', { source: String(fn), isFunction: isFunction, arg: arg === undefined ? null : arg });
          return out.value;
        },
      });
    })(),
    log: (...args) => { send('log', 0, '', toJson(args.map(text), 'ctx.log')); },
    emit: (item) => { send('emit', 0, '', toJson(item, 'ctx.emit')); },
  });
  const FORBIDDEN = ['require', 'process', 'module', 'exports', 'Buffer', 'global', '__dirname', '__filename',
    'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'navigator', 'importScripts', 'Deno', 'Bun',
    'WebAssembly', 'SharedArrayBuffer', 'Atomics'];
  for (const name of FORBIDDEN) {
    try { delete globalThis[name]; } catch (e) { /* non configurable : redéfini ci-dessous si possible */ }
    const trap = () => {
      send('violation', 0, 'forbidden_global', name);
      throw new ReferenceError(name + " n'est pas disponible dans le bac à sable");
    };
    Object.defineProperty(globalThis, name, { configurable: false, enumerable: false, get: trap, set: trap });
  }
  Object.defineProperty(globalThis, 'ctx', { value: ctx, writable: false, configurable: false, enumerable: false });
  Object.defineProperty(globalThis, 'input', { value: JSON.parse(inputJson), writable: false, configurable: false, enumerable: false });
  return function settle(id, ok, payload) {
    const entry = pending.get(id);
    if (entry === undefined) return;
    pending.delete(id);
    if (ok) entry.resolve(payload);
    else entry.reject(new SandboxError(String(payload)));
  };
})`;

/** Enveloppe du script : corps d'une fonction asynchrone ; résultat rendu en JSON. */
function wrapScript(code: string): string {
  return `(async () => {\n${code}\n})().then((v) => { const s = JSON.stringify(v === undefined ? null : v); return s === undefined ? 'null' : s; })`;
}

/** Surface commune des moteurs d'isolat, côté enfant. */
export type GuestSend = (kind: unknown, id: unknown, a: unknown, b: unknown) => void;
export interface ChildRunner {
  /** Rend la valeur JSON (chaîne) du script ; lève sur erreur. */
  run(code: string): Promise<string>;
  /** Règle un appel de pont en attente (réponse du parent). */
  settle(id: number, ok: boolean, payload: string): void;
  /** `memory` : plafond mémoire ; `timeout` : plafond de temps ; `import` : `import()` refusé par le moteur. */
  classify(error: unknown): 'memory' | 'timeout' | 'import' | 'script_error';
}
export type GuestCode = { bootstrap: string; wrap: (code: string) => string };
export type RunnerFactory = (msg: RunMessage, send: GuestSend, guest: GuestCode) => Promise<ChildRunner>;

const MAX_ERROR = 1000;
/** Erreurs d'allocation (isolat saturé, ArrayBuffer ou chaîne refusés) : classées « mémoire ». */
const MEMORY_ERROR = /memory limit|allocation failed|out of memory|string too long|invalid string length/i;

/** Octets (UTF-8) écrits par le script mais pas encore remis au système (file IPC, dans le tas de l'enfant). */
let backlog = 0;
/**
 * Au-delà, le script produit plus vite que l'hôte ne consomme : violation plutôt qu'un tas saturé (abort). Supérieur au
 * plafond cumulé des éléments (50 Mio) : une sortie légitime tient toujours dans la file, même émise d'un trait. Le tas
 * de l'enfant (--max-old-space-size, engine.ts) est dimensionné en conséquence.
 */
const MAX_BACKLOG = 64 * 1024 * 1024;

function post(message: ChildMessage, bytes = 0): void {
  backlog += bytes;
  process.send?.(message, undefined, undefined, () => {
    backlog -= bytes;
  });
}

async function ivmRunner(msg: RunMessage, send: GuestSend, guest: GuestCode): Promise<ChildRunner> {
  const { default: ivm } = await import('isolated-vm');
  const isolate = new ivm.Isolate({
    memoryLimit: msg.limits.memoryMb,
    // v8 a perdu le contrôle de l'isolat : rien n'est récupérable, on s'arrête.
    onCatastrophicError: () => process.abort(),
  });
  const context = await isolate.createContext();
  // Une seule fonction de l'hôte, en mode « ignored » : l'isolat ne reçoit ni Reference ni objet de l'hôte.
  const callback = new ivm.Callback(send, { ignored: true });
  const settleRef = await context.evalClosure(`return ${guest.bootstrap}($0, $1);`, [callback, msg.inputJson], {
    result: { reference: true },
  });
  return {
    async run(code) {
      const out: unknown = await context.evalClosure(`return ${guest.wrap(code)};`, [], {
        timeout: msg.limits.timeoutMs,
        result: { promise: true },
      });
      return typeof out === 'string' ? out : 'null';
    },
    settle(id, ok, payload) {
      if (isolate.isDisposed) return;
      settleRef.apply(undefined, [id, ok, payload], { arguments: { copy: true } }).catch(() => undefined);
    },
    classify(error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isolate.isDisposed || MEMORY_ERROR.test(message)) return 'memory';
      if (/timed out/i.test(message)) return 'timeout';
      // isolated-vm n'expose pas de crochet d'import dynamique : v8 rejette `import()` par « Not supported ». Un import
      // en clair est refusé avant le lancement (engine.ts) ; celui-ci couvre un import masqué (eval) non rattrapé.
      if (message === 'Not supported') return 'import';
      return 'script_error';
    },
  };
}

async function main(): Promise<void> {
  if (process.send === undefined) process.exit(70);
  // Vérification de l'environnement vide : le parent refuse de lancer le run si une variable est visible.
  post({ t: 'ready', envKeys: Object.keys(process.env), node: process.versions.node });
  const rss = setInterval(() => post({ t: 'rss', mb: Math.round(process.memoryUsage.rss() / 1048576) }), 100);
  rss.unref();

  let runner: ChildRunner | undefined;
  // Budget d'octets sortants, aussi tenu ici (le parent tient le sien) : quand le script ne rend jamais la main (QuickJS
  // est synchrone) ou produit plus vite que l'hôte ne lit, les messages s'accumulent dans la file IPC de l'enfant ; au-delà
  // du budget ou de la file maximale, ils sont abandonnés et la violation signalée.
  let outBudget = Number.POSITIVE_INFINITY;
  let outBytes = 0;
  let overflow = false;
  const send: GuestSend = (kind, id, a, b) => {
    if (overflow) return;
    const size = typeof b === 'string' ? Buffer.byteLength(b) : 0;
    if (kind === 'call' || kind === 'log' || kind === 'emit') {
      outBytes += size;
      if (outBytes > outBudget || backlog + size > MAX_BACKLOG) {
        overflow = true;
        post({ t: 'violation', reason: 'output_limit', detail: outBytes > outBudget ? 'ipc' : 'file IPC' });
        return;
      }
    }
    if (kind === 'call' && typeof id === 'number' && (a === 'fetch' || a === 'page') && typeof b === 'string') {
      post({ t: 'call', id, bridge: a, payload: b }, size);
    } else if (kind === 'log' && typeof b === 'string') post({ t: 'log', payload: b }, size);
    else if (kind === 'emit' && typeof b === 'string') post({ t: 'emit', payload: b }, size);
    else if (kind === 'violation' && (a === 'forbidden_global' || a === 'forbidden_import') && typeof b === 'string') {
      post({ t: 'violation', reason: a, detail: b.slice(0, 64) });
    } else post({ t: 'violation', reason: 'invalid_bridge_call', detail: 'send' });
  };

  process.on('message', (raw: ParentMessage) => {
    if (raw.t === 'reply') {
      runner?.settle(raw.id, raw.ok, raw.payload);
      return;
    }
    if (raw.t !== 'run' || runner !== undefined) return;
    const msg = raw;
    outBudget = msg.limits.maxIpcBytes;
    void (async () => {
      let factory: RunnerFactory = ivmRunner;
      if (msg.engine === 'quickjs') {
        const self = import.meta.url;
        const spec = new URL(self.endsWith('.ts') ? './quickjs-runner.ts' : './quickjs-runner.js', self);
        factory = ((await import(spec.href)) as { quickjsRunner: RunnerFactory }).quickjsRunner;
      }
      let current: ChildRunner | undefined;
      try {
        current = await factory(msg, send, { bootstrap: GUEST_BOOTSTRAP, wrap: wrapScript });
        runner = current;
        const value = await current.run(msg.code);
        post({ t: 'done', outcome: 'ok', value });
      } catch (error) {
        const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        // Moteur qui ne démarre pas : ce n'est pas une erreur du script (le parent le journalise child_crashed).
        const kind = current === undefined ? 'engine_error' : current.classify(error);
        if (kind === 'import') {
          post({ t: 'violation', reason: 'forbidden_import', detail: 'import()' });
          post({ t: 'done', outcome: 'script_error', error: message.slice(0, MAX_ERROR) });
        } else post({ t: 'done', outcome: kind, error: message.slice(0, MAX_ERROR) });
      }
    })();
  });
}

if (process.send !== undefined) void main();
