// SPDX-License-Identifier: AGPL-3.0-only
// Chaînage du proxy d'egress de Chromium vers le proxy BYO de l'admin (tâche 1.6 ; 08 §2 ; 08b §1). La cible a déjà été
// contrôlée par la garde (schéma, port, résolution unique) ; ce module n'ouvre que la connexion AU PROXY, sous sa garde
// propre (`proxyGuardFor`, classe `operator-config`), puis le tunnel : CONNECT (proxy http ou https) ou SOCKS5
// (RFC 1928, authentification RFC 1929). Le proxy résout ensuite le nom de la cible lui-même : risque résiduel
// documenté (08 §2), le même que la couche fetch (1.4). Identifiants jamais journalisés (INV8), octets comptés pour le
// coût proxy du run.
import { isIP, connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { secretValues } from '../../crypto/index.js';
import type { Resolver } from '../guard.js';
import { NetworkConfigError, renderProxyUsername, type ProviderParams, type ProxyDefinition } from './definitions.js';
import { proxyGuardFor, type ProxyCredentials } from './session.js';

export type UpstreamProxyErrorCode = 'proxy_auth_failed' | 'proxy_refused' | 'proxy_protocol' | 'proxy_timeout';

/** Échec du proxy amont. Le message ne contient ni identifiant ni corps de réponse du proxy. */
export class UpstreamProxyError extends Error {
  override name = 'UpstreamProxyError';
  readonly code: UpstreamProxyErrorCode;
  readonly status: number | undefined;
  constructor(code: UpstreamProxyErrorCode, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export type UpstreamDialerOptions = {
  readonly proxy: ProxyDefinition;
  readonly params: ProviderParams;
  readonly credentials?: ProxyCredentials;
  /** Résolveur de la garde du proxy (tests). */
  readonly proxyResolver?: Resolver;
  readonly connectTimeoutMs?: number;
};

export type UpstreamUsage = { readonly bytes: number; readonly tunnels: number };

export type UpstreamDialer = {
  /** Ouvre un tunnel vers `host:port` par le proxy ; le socket rendu transporte les octets de la cible. */
  dial(host: string, port: number): Promise<Socket>;
  /** Octets émis et reçus sur les connexions au proxy, tunnels ouverts (base du coût, `proxyCostUsd`). */
  usage(): UpstreamUsage;
};

const DEFAULT_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443, 'socks5:': 1080 };
const MAX_HANDSHAKE_BYTES = 16 * 1024;

/** Lecture tamponnée d'une poignée de main : aucun octet perdu, le reste est rendu au flux à la fin. */
function handshakeReader(socket: Socket, timeoutMs: number) {
  let buffer = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    wake?.();
  };
  const onData = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_HANDSHAKE_BYTES) fail(new UpstreamProxyError('proxy_protocol', 'réponse du proxy trop longue'));
    wake?.();
  };
  const onClose = () => fail(new UpstreamProxyError('proxy_protocol', 'connexion au proxy fermée pendant la poignée de main'));
  const onError = () => fail(new UpstreamProxyError('proxy_protocol', 'erreur de connexion au proxy'));
  socket.on('data', onData);
  socket.on('close', onClose);
  socket.on('error', onError);
  const timer = setTimeout(() => fail(new UpstreamProxyError('proxy_timeout', 'délai de poignée de main du proxy dépassé')), timeoutMs);

  const take = async (size: () => number | undefined): Promise<Buffer> => {
    for (;;) {
      if (failure !== undefined) throw failure;
      const n = size();
      if (n !== undefined) {
        const out = buffer.subarray(0, n);
        buffer = buffer.subarray(n);
        return out;
      }
      await new Promise<void>((resolve) => (wake = resolve));
      wake = undefined;
    }
  };
  return {
    read: (n: number) => take(() => (buffer.length >= n ? n : undefined)),
    readHead: () =>
      take(() => {
        const end = buffer.indexOf('\r\n\r\n');
        return end < 0 ? undefined : end + 4;
      }),
    /** Fin de la poignée de main : écouteurs retirés (le flux reste en l'état), octets en trop rendus au flux. */
    finish(): void {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (buffer.length > 0) socket.unshift(buffer);
    },
    abort(): void {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onError);
    },
  };
}

function authority(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

/** Corps de la poignée de main SOCKS5 CONNECT (ATYP 1, 3 ou 4). */
function socksConnectRequest(host: string, port: number): Buffer {
  const portBytes = Buffer.from([port >> 8, port & 0xff]);
  const family = isIP(host);
  if (family === 4) return Buffer.concat([Buffer.from([5, 1, 0, 1, ...host.split('.').map(Number)]), portBytes]);
  if (family === 6) {
    const groups = expandIpv6(host);
    const bytes = Buffer.alloc(16);
    groups.forEach((g, i) => bytes.writeUInt16BE(g, i * 2));
    return Buffer.concat([Buffer.from([5, 1, 0, 4]), bytes, portBytes]);
  }
  const name = Buffer.from(host, 'utf8');
  if (name.length > 255) throw new UpstreamProxyError('proxy_protocol', 'nom d’hôte trop long pour SOCKS5');
  return Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, portBytes]);
}

function expandIpv6(address: string): number[] {
  const [head = '', tail] = address.split('::');
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((h) => parseInt(h, 16)));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/**
 * Connecteur amont d'un proxy BYO pour le proxy d'egress de Chromium. Chaque `dial` : garde du proxy (résolution
 * unique, adresse épinglée, privé refusé sauf dérogation admin), TLS si `https://`, puis tunnel vers la cible.
 */
export function createUpstreamDialer(options: UpstreamDialerOptions): UpstreamDialer {
  const { proxy, params, credentials } = options;
  const timeoutMs = options.connectTimeoutMs ?? 10_000;
  const proxyUrl = new URL(proxy.url);
  const proxyHost = proxyUrl.hostname.replace(/^\[|\]$/g, '');
  const proxyPort = proxyUrl.port === '' ? (DEFAULT_PORTS[proxyUrl.protocol] ?? 0) : Number(proxyUrl.port);
  const guard = proxyGuardFor(proxy, options.proxyResolver);
  const username = credentials === undefined ? undefined : renderProxyUsername(proxy.usernameTemplate, credentials.username.reveal(), params);
  if (username !== undefined) secretValues.add(username);

  let closedBytes = 0;
  let tunnels = 0;
  const live = new Set<Socket>();

  const openToProxy = async (): Promise<{ raw: Socket; stream: Socket }> => {
    const pinned = await guard.resolve(proxyHost, proxyPort);
    const raw = await new Promise<Socket>((resolve, reject) => {
      const socket = netConnect({ host: pinned.address, port: proxyPort });
      const timer = setTimeout(() => socket.destroy(new UpstreamProxyError('proxy_timeout', 'connexion au proxy : délai dépassé')), timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    try {
      guard.checkAddress(proxyHost, raw.remoteAddress ?? '', proxyPort);
    } catch (error) {
      raw.destroy();
      throw error;
    }
    live.add(raw);
    raw.once('close', () => {
      closedBytes += raw.bytesRead + raw.bytesWritten;
      live.delete(raw);
    });
    if (proxyUrl.protocol !== 'https:') return { raw, stream: raw };
    const secure = await new Promise<Socket>((resolve, reject) => {
      const tls = tlsConnect({ socket: raw, ...(isIP(proxyHost) === 0 ? { servername: proxyHost } : {}) });
      const timer = setTimeout(() => tls.destroy(new UpstreamProxyError('proxy_timeout', 'TLS du proxy : délai dépassé')), timeoutMs);
      tls.once('secureConnect', () => {
        clearTimeout(timer);
        resolve(tls);
      });
      tls.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return { raw, stream: secure };
  };

  const connectTunnel = async (stream: Socket, host: string, port: number): Promise<void> => {
    const reader = handshakeReader(stream, timeoutMs);
    try {
      const target = authority(host, port);
      const lines = [`CONNECT ${target} HTTP/1.1`, `Host: ${target}`];
      if (credentials !== undefined && username !== undefined) {
        const token = Buffer.from(`${username}:${credentials.password.reveal()}`).toString('base64');
        secretValues.add(token);
        lines.push(`Proxy-Authorization: Basic ${token}`);
      }
      stream.write(`${lines.join('\r\n')}\r\n\r\n`);
      const head = (await reader.readHead()).toString('latin1');
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? NaN);
      if (status === 407) throw new UpstreamProxyError('proxy_auth_failed', 'proxy : authentification refusée (407)', status);
      if (!(status >= 200 && status < 300)) throw new UpstreamProxyError('proxy_refused', `proxy : CONNECT refusé (${Number.isNaN(status) ? 'réponse illisible' : status})`, status);
      reader.finish();
    } catch (error) {
      reader.abort();
      throw error;
    }
  };

  const socksTunnel = async (stream: Socket, host: string, port: number): Promise<void> => {
    const reader = handshakeReader(stream, timeoutMs);
    try {
      const auth = credentials !== undefined && username !== undefined ? { username, password: credentials.password } : undefined;
      stream.write(Buffer.from(auth !== undefined ? [5, 2, 0, 2] : [5, 1, 0]));
      const [version, method] = await reader.read(2);
      if (version !== 5 || method === 0xff) throw new UpstreamProxyError('proxy_refused', 'SOCKS5 : aucune méthode acceptée');
      if (method === 2) {
        if (auth === undefined) throw new UpstreamProxyError('proxy_auth_failed', 'SOCKS5 : authentification exigée');
        const user = Buffer.from(auth.username, 'utf8');
        const pass = Buffer.from(auth.password.reveal(), 'utf8');
        if (user.length > 255 || pass.length > 255) throw new NetworkConfigError(`proxy ${proxy.id} : identifiants trop longs pour SOCKS5`);
        stream.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
        const [, ok] = await reader.read(2);
        if (ok !== 0) throw new UpstreamProxyError('proxy_auth_failed', 'SOCKS5 : authentification refusée');
      } else if (method !== 0) {
        throw new UpstreamProxyError('proxy_protocol', 'SOCKS5 : méthode inattendue');
      }
      stream.write(socksConnectRequest(host, port));
      const [v, rep, , atyp] = await reader.read(4);
      if (v !== 5) throw new UpstreamProxyError('proxy_protocol', 'SOCKS5 : réponse illisible');
      if (rep !== 0) throw new UpstreamProxyError('proxy_refused', `SOCKS5 : CONNECT refusé (code ${rep ?? '?'})`);
      const addrLength = atyp === 1 ? 4 : atyp === 4 ? 16 : atyp === 3 ? ((await reader.read(1))[0] ?? 0) : -1;
      if (addrLength < 0) throw new UpstreamProxyError('proxy_protocol', 'SOCKS5 : type d’adresse inconnu');
      await reader.read(addrLength + 2);
      reader.finish();
    } catch (error) {
      reader.abort();
      throw error;
    }
  };

  return {
    async dial(host, port) {
      const { raw, stream } = await openToProxy();
      try {
        if (proxyUrl.protocol === 'socks5:') await socksTunnel(stream, host, port);
        else await connectTunnel(stream, host, port);
      } catch (error) {
        stream.destroy();
        raw.destroy();
        throw error;
      }
      tunnels += 1;
      return stream;
    },
    usage() {
      let bytes = closedBytes;
      for (const s of live) bytes += s.bytesRead + s.bytesWritten;
      return { bytes, tunnels };
    },
  };
}
