// SPDX-License-Identifier: AGPL-3.0-only
// Navigateur simulé sous Node pour l'exécuteur RÉEL de l'extension (apps/extension/src/core/tunnel-executor.ts) : les
// commandes `page_fetch` / `http_fetch` deviennent de vraies requêtes HTTP vers un serveur de fixtures local (l'hôte
// `zz-test-*.example` est réécrit en 127.0.0.1:port, aucun site réel), l'inspection de page lit la page d'accueil. Sert
// aux tests d'intégration du mode tunnel (passerelle + worker + exécuteur de l'extension), sans Chromium.
import type { BrowserApi, TabInfo } from '../../apps/extension/src/core/browser-api.ts';

export function nodeBrowserApi(port: number): { api: BrowserApi; calls: string[] } {
  const calls: string[] = [];
  const tabs = new Map<number, TabInfo>();
  let next = 1;
  const local = (url: string) => {
    const u = new URL(url);
    return `http://127.0.0.1:${port}${u.pathname}${u.search}`;
  };
  const get = async (url: string, init: { method: string; headers: Record<string, string>; body?: string | null } = { method: 'GET', headers: {} }) => {
    const res = await fetch(local(url), { method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}), redirect: 'manual' });
    return { status: res.status, headers: [...res.headers.entries()], body: await res.text() };
  };
  const api: BrowserApi = {
    tabs: {
      create: async (url) => {
        calls.push(`tabs.create ${url}`);
        const tab: TabInfo = { id: next++, url, status: 'complete', active: false, autoDiscardable: true };
        tabs.set(tab.id, tab);
        return tab;
      },
      get: async (id) => tabs.get(id) ?? null,
      keep: async (id) => void (tabs.get(id)!.autoDiscardable = false),
      reload: async () => undefined,
      remove: async (id) => void tabs.delete(id),
      waitComplete: async () => true,
      group: async () => undefined,
    },
    scripting: {
      pageFetch: async (_tabId, request) => {
        calls.push(`pageFetch ${request.method} ${request.url}`);
        const res = await get(request.url, request);
        if (Buffer.byteLength(res.body) > request.maxBytes) return { kind: 'too_large' };
        return { kind: 'ok', status: res.status, headers: JSON.stringify(Object.fromEntries(res.headers)), body: res.body, url: request.url };
      },
      inspect: async (tabId) => {
        const url = tabs.get(tabId)?.url ?? '';
        if (!/^https?:/.test(url)) return null;
        calls.push(`inspect ${url}`);
        const res = await get(url);
        return { title: /<title>([^<]*)<\/title>/i.exec(res.body)?.[1] ?? '', url, text: res.body };
      },
    },
    debugger: {
      attach: async () => undefined,
      detach: async () => undefined,
      send: async () => {
        throw new Error('page_script non simulé');
      },
      onEvent: () => () => undefined,
    },
    permissions: { contains: async () => true },
    fetch: async (url, init) => {
      calls.push(`fetch ${init.method} ${url}`);
      const res = await get(url, init);
      return { status: res.status, url, headers: res.headers, text: async (max) => (Buffer.byteLength(res.body) > max ? null : res.body) };
    },
  };
  return { api, calls };
}
