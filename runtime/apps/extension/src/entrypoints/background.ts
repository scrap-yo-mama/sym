// SPDX-License-Identifier: AGPL-3.0-only
// Service worker (07 § 2, § 4) : seul contexte qui lit des cookies, via le noyau (`ExtensionController`). Reçoit les
// messages du popup (jeu fermé), resynchronise les domaines en usage serveur à l'ouverture de Chrome et toutes les
// heures (alarme). La WSS du tunnel et son alarme de 30 s arrivent avec la tâche 2.7.
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { ensurePeriodicAlarm } from '../core/alarms.ts';
import { ExtensionController, ExtensionError, type BrowserCookie, type Status } from '../core/controller.ts';
import { parseRequest, type Request, type Response } from '../core/messages.ts';

const RESYNC_ALARM = 'scrapyomama-cookie-resync';

export default defineBackground(() => {
  const controller = new ExtensionController({
    storage: {
      get: async (key) => (await browser.storage.local.get(key))[key],
      set: (key, value) => browser.storage.local.set({ [key]: value }),
      remove: (key) => browser.storage.local.remove(key),
    },
    permissions: {
      contains: (origins) => browser.permissions.contains({ origins }),
      remove: (origins) => browser.permissions.remove({ origins }),
    },
    cookies: { getAll: (details) => browser.cookies.getAll(details) as Promise<BrowserCookie[]> },
    fetch: (url, init) => fetch(url, { ...init, credentials: 'omit', cache: 'no-store' }),
    randomId: () => crypto.randomUUID(),
    version: browser.runtime.getManifest().version,
  });

  async function handle(request: Request): Promise<unknown> {
    switch (request.type) {
      case 'status':
        return controller.status();
      case 'pair':
        await controller.pair(request);
        return controller.status();
      case 'connectSite':
        return controller.connectSite({ domain: request.domain, mode: request.mode, now: new Date().toISOString() });
      case 'disconnectSite': {
        // Effacement local d'abord, toujours ; l'échec côté instance revient en avertissement (`notice`).
        const revocation = await controller.disconnectSite(request.domain);
        const status = await controller.status();
        return (revocation.remoteRevoked ? status : { ...status, notice: revocation.warning }) satisfies Status;
      }
      case 'unpair': {
        const revocation = await controller.unpair();
        return (revocation.remoteRevoked ? { paired: false } : { paired: false, notice: revocation.warning }) satisfies Status;
      }
    }
  }

  browser.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    // Seules les pages de l'extension (popup, options) parlent au service worker.
    if (sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL('/'))) return false;
    const request = parseRequest(raw);
    if (!request) {
      sendResponse({ ok: false, code: 'invalid_message', message: 'message inconnu' } satisfies Response);
      return false;
    }
    handle(request).then(
      (data) => sendResponse({ ok: true, data } satisfies Response),
      (error: unknown) =>
        sendResponse({
          ok: false,
          code: error instanceof ExtensionError ? error.code : 'internal',
          message: error instanceof Error ? error.message : 'erreur',
        } satisfies Response),
    );
    return true;
  });

  browser.runtime.onStartup.addListener(() => {
    void controller.resyncAll();
  });
  // Créée une seule fois : la recréer à chaque réveil du service worker remettrait son délai à zéro.
  void ensurePeriodicAlarm(browser.alarms, RESYNC_ALARM, 60);
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RESYNC_ALARM) void controller.resyncAll();
  });
});
