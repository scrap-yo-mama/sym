// SPDX-License-Identifier: AGPL-3.0-only
// Implémentation Chrome des capacités du tunnel (core/browser-api.ts). Seul fichier qui appelle `chrome.debugger`,
// `chrome.scripting.executeScript` et `chrome.tabGroups` ; `chrome.debugger.sendCommand` n'est appelé qu'après le
// contrôle de la liste blanche CDP (`assert_cdp_allowlist`). Onglets d'automatisation : `active: false`,
// `autoDiscardable: false`, groupe « Scrapyomama » (07 § 4).
import { browser } from 'wxt/browser';
import { checkCdpCommand } from '../core/allowlist.ts';
import type { BrowserApi, InPageRequest, InPageResult, PageInspection, TabInfo } from '../core/browser-api.ts';
import { inspectPage, pageFetchInPage } from '../core/in-page.ts';

const GROUP_TITLE = 'Scrapyomama';
const GROUP_KEY = 'tunnel_group_id';

type ChromeTab = { id?: number; url?: string; status?: string; discarded?: boolean; frozen?: boolean; autoDiscardable?: boolean; active?: boolean; groupId?: number };

const info = (tab: ChromeTab): TabInfo => ({
  id: tab.id ?? -1,
  ...(tab.url === undefined ? {} : { url: tab.url }),
  ...(tab.status === undefined ? {} : { status: tab.status }),
  ...(tab.discarded === undefined ? {} : { discarded: tab.discarded }),
  ...(tab.frozen === undefined ? {} : { frozen: tab.frozen }),
  ...(tab.autoDiscardable === undefined ? {} : { autoDiscardable: tab.autoDiscardable }),
  ...(tab.active === undefined ? {} : { active: tab.active }),
  ...(tab.groupId === undefined ? {} : { groupId: tab.groupId }),
});

async function groupId(windowId: number | undefined): Promise<number | undefined> {
  const stored = (await browser.storage.session.get(GROUP_KEY))[GROUP_KEY];
  if (typeof stored !== 'number') return undefined;
  try {
    const group = await browser.tabGroups.get(stored);
    return windowId === undefined || group.windowId === windowId ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function chromeBrowserApi(): BrowserApi {
  const eventHandlers = new Map<number, Set<(method: string, params: unknown) => void>>();
  browser.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) return;
    for (const handler of eventHandlers.get(source.tabId) ?? []) handler(method, params);
  });

  return {
    tabs: {
      create: async (url) => info((await browser.tabs.create({ url, active: false })) as ChromeTab),
      get: async (tabId) => {
        try {
          return info((await browser.tabs.get(tabId)) as ChromeTab);
        } catch {
          return null;
        }
      },
      keep: async (tabId) => void (await browser.tabs.update(tabId, { autoDiscardable: false })),
      reload: (tabId) => browser.tabs.reload(tabId),
      remove: (tabId) => browser.tabs.remove(tabId),
      waitComplete: (tabId, timeoutMs) =>
        new Promise<boolean>((resolve) => {
          let done = false;
          const finish = (value: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            browser.tabs.onUpdated.removeListener(listener);
            resolve(value);
          };
          const listener = (id: number, change: { status?: string }) => {
            if (id === tabId && change.status === 'complete') finish(true);
          };
          const timer = setTimeout(() => finish(false), timeoutMs);
          browser.tabs.onUpdated.addListener(listener);
          browser.tabs.get(tabId).then(
            (tab) => {
              if (tab.status === 'complete') finish(true);
            },
            () => finish(false),
          );
        }),
      group: async (tabId) => {
        const tab = (await browser.tabs.get(tabId)) as ChromeTab & { windowId?: number };
        const existing = await groupId(tab.windowId);
        const id = await browser.tabs.group(existing === undefined ? { tabIds: [tabId] } : { tabIds: [tabId], groupId: existing });
        if (existing === undefined) {
          await browser.tabGroups.update(id, { title: GROUP_TITLE, collapsed: true });
          await browser.storage.session.set({ [GROUP_KEY]: id });
        }
      },
    },
    scripting: {
      pageFetch: async (tabId, request: InPageRequest) => {
        const [out] = await browser.scripting.executeScript({ target: { tabId }, func: pageFetchInPage, args: [request] });
        return (out?.result as InPageResult | undefined) ?? { kind: 'error' };
      },
      inspect: async (tabId) => {
        const [out] = await browser.scripting.executeScript({ target: { tabId }, func: inspectPage });
        return (out?.result as PageInspection | undefined) ?? null;
      },
    },
    debugger: {
      attach: (tabId) => browser.debugger.attach({ tabId }, '1.3'),
      detach: async (tabId) => {
        eventHandlers.delete(tabId);
        await browser.debugger.detach({ tabId });
      },
      send: async (tabId, method, params) => {
        // Liste blanche figée (07 § 3) : rien d'autre ne part vers le débogueur, y compris pour l'usage interne.
        const verdict = checkCdpCommand(method, params);
        if (!verdict.ok) throw new Error(`method_not_allowed: ${verdict.reason}`);
        return browser.debugger.sendCommand({ tabId }, method, params);
      },
      onEvent: (tabId, handler) => {
        const set = eventHandlers.get(tabId) ?? new Set();
        eventHandlers.set(tabId, set);
        set.add(handler);
        return () => set.delete(handler);
      },
    },
    permissions: { contains: (origins) => browser.permissions.contains({ origins }) },
    fetch: async (url, init) => {
      // `http_fetch` (07 § 3) : depuis le service worker, cookies du navigateur, aucun en-tête d'identité posé.
      const res = await fetch(url, { ...init, credentials: 'include', redirect: 'follow', cache: 'no-store' });
      return {
        status: res.status,
        url: res.url,
        headers: [...res.headers.entries()],
        text: async (max) => {
          const reader = res.body?.getReader();
          if (reader === undefined) return '';
          const parts: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > max) {
              await reader.cancel().catch(() => undefined);
              return null;
            }
            parts.push(chunk.value);
          }
          const buffer = new Uint8Array(size);
          let offset = 0;
          for (const part of parts) {
            buffer.set(part, offset);
            offset += part.byteLength;
          }
          return new TextDecoder().decode(buffer);
        },
      };
    },
  };
}
