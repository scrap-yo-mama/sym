// SPDX-License-Identifier: AGPL-3.0-only
// Branchement de Chromium sur l'egress (cdc/sym-browser 04c § 1.1), valeurs figées dans le code, reprises par le pool (1.1)
// et les sessions (1.3, 1.4). La résolution appartient à l'egress (`--host-resolver-rules` : toute résolution locale de
// Chromium échoue), WebRTC n'a pas d'UDP hors proxy (le TURN/TCP passe en CONNECT par l'egress). La boucle locale passe aussi
// par l'egress (`<-loopback>`), d'où le refus de `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK`.

export const FORCED_LOOPBACK_OPT_OUT_ENV = 'PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK';

/** Arguments figés communs à `shared` et `dedicated`. */
export const EGRESS_FROZEN_ARGS: readonly string[] = Object.freeze([
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
]);

type Env = Readonly<Record<string, string | undefined>>;

/** URL d'egress acceptée : `http://127.0.0.1:PORT` seulement. Refuse aussi la variable de contournement de la boucle locale. */
function egressServer(egressUrl: string, env: Env): string {
  if (env[FORCED_LOOPBACK_OPT_OUT_ENV] !== undefined) {
    throw new Error(`${FORCED_LOOPBACK_OPT_OUT_ENV} est interdite : la boucle locale doit passer par l'egress de la session`);
  }
  let url: URL;
  try {
    url = new URL(egressUrl);
  } catch {
    throw new Error("l'egress doit être http://127.0.0.1:PORT");
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === '' || url.pathname !== '/' || url.username !== '') {
    throw new Error("l'egress doit être http://127.0.0.1:PORT");
  }
  return `http://127.0.0.1:${url.port}`;
}

/** Chromium `dedicated` : lancé directement sur l'egress de sa session (`--proxy-server`), boucle locale comprise. */
export function dedicatedChromiumArgs(egressUrl: string, env: Env = process.env): string[] {
  return [`--proxy-server=${egressServer(egressUrl, env)}`, '--proxy-bypass-list=<-loopback>', ...EGRESS_FROZEN_ARGS];
}

/** Chromium chaud `shared` : lancé sur le proxy fermé (`startClosedEgress`) ; Playwright ajoute `<-loopback>` au contournement. */
export function sharedLaunchOptions(closedEgressUrl: string, env: Env = process.env): { proxy: { server: string }; args: string[] } {
  return { proxy: { server: egressServer(closedEgressUrl, env) }, args: [...EGRESS_FROZEN_ARGS] };
}

/** Options d'un contexte `shared` : `proxy` posé par le nœud sur l'egress de la session, toute valeur du client écartée. */
export function sharedContextOptions<T extends { proxy?: unknown }>(clientOptions: T, egressUrl: string): Omit<T, 'proxy'> & { proxy: { server: string } } {
  const { proxy: _ignored, ...rest } = clientOptions;
  return { ...rest, proxy: { server: egressServer(egressUrl, {}) } };
}
