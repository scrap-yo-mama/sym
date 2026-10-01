// SPDX-License-Identifier: AGPL-3.0-only
// Service worker (07 § 2, § 4, § 6) : seul contexte qui lit des cookies, via le noyau (`ExtensionController`). Reçoit les
// messages du popup (jeu fermé), resynchronise les domaines en usage serveur à l'ouverture de Chrome et toutes les
// heures (alarme). Tunnel (tâche 2.7) : WSS sortante vers l'instance appairée (`TunnelClient`), ping toutes les 20 s,
// alarme de 30 s qui relance la connexion après un arrêt du service worker, exécuteur au jeu fermé de commandes.
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { TUNNEL_ALARM_PERIOD_MINUTES } from '@runtime/core/tunnel';
import { ensurePeriodicAlarm } from '../core/alarms.ts';
import { ExtensionController, ExtensionError, type BrowserCookie, type Status } from '../core/controller.ts';
import { parseRequest, type Request, type Response } from '../core/messages.ts';
import { TunnelClient, type WebSocketLike } from '../core/tunnel-client.ts';
import { TunnelExecutor } from '../core/tunnel-executor.ts';
import { chromeBrowserApi } from '../platform/chrome-api.ts';

const RESYNC_ALARM = 'scrapyomama-cookie-resync';
const TUNNEL_ALARM = 'scrapyomama-tunnel';

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

  const executor = new TunnelExecutor({ browser: chromeBrowserApi(), connectedDomains: () => controller.connectedDomains() });
  const tunnel = new TunnelClient({
    createSocket: (url) => new WebSocket(url) as unknown as WebSocketLike,
    pairing: () => controller.tunnelPairing(),
    version: browser.runtime.getManifest().version,
    execute: (frame) => executor.run(frame),
    onUnauthorized: () => controller.forgetRevokedPairing(),
    session: {
      get: async (key) => (await browser.storage.session.get(key))[key],
      set: (key, value) => browser.storage.session.set({ [key]: value }),
    },
  });

  async function handle(request: Request): Promise<unknown> {
    switch (request.type) {
      case 'status':
        return controller.status();
      case 'pair':
        await controller.pair(request);
        // Nouvel appairage : la WSS de l'ancienne instance est fermée, celle de la nouvelle ouverte.
        tunnel.disconnect();
        void tunnel.ensureConnected(true);
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
        tunnel.disconnect();
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
    // Ouverture de Chrome : ce navigateur reprend la main sur le tunnel (une connexion plus récente gagne, 07 § 6).
    void tunnel.ensureConnected(true);
  });
  // Créées une seule fois : les recréer à chaque réveil du service worker remettrait leur délai à zéro.
  void ensurePeriodicAlarm(browser.alarms, RESYNC_ALARM, 60);
  void ensurePeriodicAlarm(browser.alarms, TUNNEL_ALARM, TUNNEL_ALARM_PERIOD_MINUTES);
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RESYNC_ALARM) void controller.resyncAll();
    // Alarme de 30 s (Chrome 120+) : relance la WSS si le service worker a été arrêté (07 § 4).
    if (alarm.name === TUNNEL_ALARM) void tunnel.ensureConnected();
  });
  // Réveil du service worker (alarme, popup, démarrage) : la WSS est (re)ouverte aussitôt.
  void tunnel.ensureConnected();
});
