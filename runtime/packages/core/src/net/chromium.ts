// SPDX-License-Identifier: AGPL-3.0-only
// Options de lancement de Chromium figées dans le code (08b §1) : tout le trafic passe par le proxy d'egress local.
// Pas de liste de contournement : Playwright ajoute alors `<-loopback>` (Chromium contourne la boucle locale sinon).
// Le DNS de Chromium ne sert à aucune décision : toute résolution locale est refusée (`~NOTFOUND`), c'est le proxy
// qui résout et contrôle. Toute navigation passe par guardedGoto : http(s) seulement (ni file:, ni view-source:,
// ni chrome:, ni data:), refusé avant que Chromium ne voie l'URL.
import { SsrfBlockedError, type SsrfGuard } from './guard.js';

export const FORCED_LOOPBACK_OPT_OUT_ENV = 'PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK';

export type ChromiumEgressLaunchOptions = {
  readonly proxy: { readonly server: string };
  readonly args: readonly string[];
};

/** Refuse toute URL de navigation hors http(s) (et les ports, identifiants refusés par la garde). */
export function assertNavigable(url: string, guard: SsrfGuard): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrfBlockedError({ reason: 'scheme', host: '' });
  }
  guard.checkUrlStatic(parsed);
  return parsed;
}

export type NavigablePage<R, O> = { goto(url: string, options?: O): Promise<R> };

/** Seule façon de naviguer pour le worker (tâche 1.6) : contrôle du schéma, puis page.goto (le proxy résout). */
export async function guardedGoto<R, O>(page: NavigablePage<R, O>, url: string, guard: SsrfGuard, options?: O): Promise<R> {
  assertNavigable(url, guard);
  return page.goto(url, options);
}

export function chromiumEgressLaunchOptions(
  proxyUrl: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ChromiumEgressLaunchOptions {
  if (env[FORCED_LOOPBACK_OPT_OUT_ENV] !== undefined) {
    // Cette variable ferait contourner le proxy pour localhost, 127.0.0.1 et ::1.
    throw new Error(`${FORCED_LOOPBACK_OPT_OUT_ENV} est interdite : la boucle locale doit passer par le proxy d'egress`);
  }
  const url = new URL(proxyUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '') {
    throw new Error("le proxy d'egress doit être http://127.0.0.1:PORT");
  }
  return Object.freeze({
    proxy: Object.freeze({ server: `http://127.0.0.1:${url.port}` }),
    args: Object.freeze([
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
      // WebRTC : pas d'UDP hors proxy ; TURN/TCP passe en CONNECT par le proxy d'egress (verrou de domaines). Validé en 1.6
      // (tests/browser/executors.security.test.ts, assert_sandbox WebRTC et WebTransport : 0 paquet ni connexion reçus).
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ]),
  });
}
