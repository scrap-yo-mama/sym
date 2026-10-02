// SPDX-License-Identifier: AGPL-3.0-only
// Relais vers le proxy amont (cdc/sym-browser 04c § 2.1, § 2.4) : le navigateur parle seulement à l'egress local, l'egress
// parle à l'amont. `http` : CONNECT avec `Proxy-Authorization: Basic` posé ici ; `https` : TLS vers le proxy (certificat
// vérifié sur son nom) puis CONNECT ; `socks5` : RFC 1928, authentification utilisateur/mot de passe RFC 1929. L'hôte du proxy
// est résolu une fois et épinglé (adresse publique ou SYMB_PRIVATE_HOSTS) ; la cible part en nom (`dnsViaProxy`) ou en
// adresse épinglée par la garde. Les identifiants restent dans ce processus (`Secret`) ; aucun message d'erreur ne les porte.
// Inspiré du relais amont du worker de SYM (`runtime/packages/core/src/net/modes/upstream.ts`, lu sans être importé).
import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import type { Duplex } from 'node:stream';
import { secretValues, type Secret } from '@sym-browser/core';
import { UPSTREAM_PROXY_KINDS, UPSTREAM_PROXY_TYPES, type UpstreamProxyKind, type UpstreamProxyType } from '@sym/contracts/browser';
import type { EgressGuard } from '../guard.js';
import { EgressPolicyError, normalizeHost } from '../policy.js';
import type { UpstreamTarget } from '../proxy.js';
import { UpstreamError, WIRE_SOCKET } from './shared.js';

/** Proxy amont tel que le nœud le tient : mot de passe en `Secret`, jamais sérialisé. */
export type UpstreamProxyConfig = {
  type: UpstreamProxyType;
  host: string;
  port: number;
  username?: string;
  password?: Secret;
  kind?: UpstreamProxyKind;
};

/** Proxy amont dont l'hôte est résolu et épinglé pour la durée de la session. */
export type ResolvedUpstream = UpstreamProxyConfig & { address: string };

export type UpstreamDialerOptions = {
  /** Délai de l'établissement complet (TCP, TLS, négociation), 10 s par défaut. */
  connectTimeoutMs?: number;
  /** Autorités de certification du proxy `https` (tests, proxy d'entreprise) ; sinon le magasin du système. */
  ca?: string | Buffer;
};

const MAX_HANDSHAKE_BYTES = 16 * 1024;

/**
 * Contrôle des champs d'un proxy amont. `prefix` nomme le champ fautif (`egress.upstream.` pour une session, vide pour un
 * profil nommé). Les valeurs ne sont jamais recopiées dans le message.
 */
export function checkUpstreamFields(input: { type?: unknown; host?: unknown; port?: unknown; username?: unknown; password?: unknown; kind?: unknown }, prefix: string, passwordLength?: number): string {
  if (!(UPSTREAM_PROXY_TYPES as readonly unknown[]).includes(input.type)) throw new EgressPolicyError(`${prefix}type`, '`http`, `https` ou `socks5` attendu');
  const host = typeof input.host === 'string' ? normalizeHost(input.host) : undefined;
  if (host === undefined) throw new EgressPolicyError(`${prefix}host`, 'nom d’hôte ou adresse IP seuls attendus');
  if (!Number.isInteger(input.port) || (input.port as number) < 1 || (input.port as number) > 65_535) throw new EgressPolicyError(`${prefix}port`, 'entier de 1 à 65535 attendu');
  if (input.kind !== undefined && input.kind !== null && !(UPSTREAM_PROXY_KINDS as readonly unknown[]).includes(input.kind)) {
    throw new EgressPolicyError(`${prefix}kind`, '`isp`, `datacenter` ou `enterprise` attendu');
  }
  const hasPassword = passwordLength !== undefined;
  if (input.username !== undefined && input.username !== null) {
    if (typeof input.username !== 'string' || input.username === '') throw new EgressPolicyError(`${prefix}username`, 'chaîne non vide attendue');
    if (Buffer.byteLength(input.username) > 255) throw new EgressPolicyError(`${prefix}username`, '255 octets au plus');
    if (input.type !== 'socks5' && input.username.includes(':')) throw new EgressPolicyError(`${prefix}username`, '« : » interdit dans un utilisateur Basic (RFC 7617)');
  } else if (hasPassword) {
    throw new EgressPolicyError(`${prefix}username`, 'un mot de passe exige un utilisateur');
  }
  if (hasPassword && (passwordLength > 255 || passwordLength === 0)) throw new EgressPolicyError(`${prefix}password`, 'de 1 à 255 octets');
  return host;
}

/**
 * Valide le proxy amont et résout son hôte une fois (A et AAAA, adresse publique ou SYMB_PRIVATE_HOSTS), à la création de
 * la session. `EgressDeniedError` si l'hôte est refusé par la garde, `EgressPolicyError` si un champ est invalide.
 */
export async function resolveUpstream(proxy: UpstreamProxyConfig, guard: EgressGuard): Promise<ResolvedUpstream> {
  const passwordLength = proxy.password === undefined ? undefined : Buffer.byteLength(proxy.password.reveal());
  const host = checkUpstreamFields(proxy, 'egress.upstream.', passwordLength);
  if (proxy.password !== undefined) secretValues.add(proxy.password.reveal());
  const pinned = await guard.resolve(host, proxy.port);
  return { ...proxy, host, address: pinned.address };
}

/** Lecteur des octets de négociation : rend la réponse complète et remet le reste dans le flux pour le tunnel. */
function handshakeReader(stream: Duplex) {
  let buffer = Buffer.alloc(0);
  let waiter: (() => void) | undefined;
  let failed: UpstreamError | undefined;
  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_HANDSHAKE_BYTES) failed = new UpstreamError('protocol_error');
    waiter?.();
  };
  const onEnd = (): void => {
    failed ??= new UpstreamError('upstream_refused');
    waiter?.();
  };
  stream.on('data', onData);
  stream.once('end', onEnd);
  stream.once('close', onEnd);
  const until = <T>(take: (data: Buffer) => { value: T; used: number } | undefined): Promise<T> =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        const got = take(buffer);
        if (got !== undefined) {
          waiter = undefined;
          buffer = buffer.subarray(got.used);
          resolve(got.value);
        } else if (failed !== undefined) {
          waiter = undefined;
          reject(failed);
        }
      };
      waiter = check;
      check();
    });
  return {
    bytes: (count: number) => until((data) => (data.length >= count ? { value: data.subarray(0, count), used: count } : undefined)),
    httpHead: () =>
      until((data) => {
        const end = data.indexOf('\r\n\r\n');
        return end === -1 ? undefined : { value: data.subarray(0, end).toString('latin1'), used: end + 4 };
      }),
    /**
     * Fin de la négociation : écouteurs retirés, reste remis en tête du flux, flux en pause jusqu'au branchement ; le premier
     * écouteur `data` du consommateur (pipe de l'egress, client HTTP) le relance (une pause explicite ne se lève pas seule).
     */
    release: (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onEnd);
      stream.pause();
      if (buffer.length > 0) stream.unshift(buffer);
      const resumeOnRead = (event: string | symbol): void => {
        if (event !== 'data') return;
        stream.removeListener('newListener', resumeOnRead);
        process.nextTick(() => stream.resume());
      };
      stream.on('newListener', resumeOnRead);
    },
  };
}

function authority(target: UpstreamTarget): string {
  const host = target.address ?? target.host;
  return isIP(host) === 6 ? `[${host}]:${target.port}` : `${host}:${target.port}`;
}

async function connectTunnel(stream: Duplex, upstream: ResolvedUpstream, target: UpstreamTarget): Promise<void> {
  const reader = handshakeReader(stream);
  try {
    const where = authority(target);
    const auth =
      upstream.username === undefined
        ? ''
        : `Proxy-Authorization: Basic ${Buffer.from(`${upstream.username}:${upstream.password?.reveal() ?? ''}`).toString('base64')}\r\n`;
    stream.write(`CONNECT ${where} HTTP/1.1\r\nHost: ${where}\r\n${auth}\r\n`);
    const head = await reader.httpHead();
    const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? '0');
    if (status === 407) throw new UpstreamError('upstream_auth_failed');
    if (status === 0) throw new UpstreamError('protocol_error');
    if (status !== 200) throw new UpstreamError('upstream_refused');
  } finally {
    reader.release();
  }
}

function socksAddress(target: UpstreamTarget): Buffer {
  const host = target.address ?? target.host;
  const family = isIP(host);
  const port = Buffer.from([target.port >> 8, target.port & 0xff]);
  if (family === 4) return Buffer.concat([Buffer.from([0x01, ...host.split('.').map(Number)]), port]);
  if (family === 6) {
    const groups = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    const [head = '', tail] = groups.split('::');
    const left = head === '' ? [] : head.split(':');
    const right = tail === undefined || tail === '' ? [] : tail.split(':');
    const all = [...left, ...Array<string>(tail === undefined ? 0 : 8 - left.length - right.length).fill('0'), ...right];
    const bytes = Buffer.alloc(16);
    all.forEach((g, i) => bytes.writeUInt16BE(Number.parseInt(g, 16), i * 2));
    return Buffer.concat([Buffer.from([0x04]), bytes, port]);
  }
  const name = Buffer.from(host);
  if (name.length > 255) throw new UpstreamError('protocol_error');
  return Buffer.concat([Buffer.from([0x03, name.length]), name, port]);
}

async function socksTunnel(stream: Duplex, upstream: ResolvedUpstream, target: UpstreamTarget): Promise<void> {
  const reader = handshakeReader(stream);
  try {
    const withAuth = upstream.username !== undefined;
    stream.write(Buffer.from([0x05, 0x01, withAuth ? 0x02 : 0x00]));
    const [version, method] = await reader.bytes(2);
    if (version !== 0x05) throw new UpstreamError('protocol_error');
    if (method === 0xff) throw new UpstreamError('upstream_auth_failed');
    if (method === 0x02 && withAuth) {
      const user = Buffer.from(upstream.username ?? '');
      const pass = Buffer.from(upstream.password?.reveal() ?? '');
      stream.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const [, status] = await reader.bytes(2);
      if (status !== 0x00) throw new UpstreamError('upstream_auth_failed');
    } else if (method !== 0x00) {
      throw new UpstreamError('protocol_error');
    }
    stream.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), socksAddress(target)]));
    const [ver, rep, , atyp] = await reader.bytes(4);
    if (ver !== 0x05) throw new UpstreamError('protocol_error');
    if (rep !== 0x00) throw new UpstreamError('upstream_refused');
    const rest = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await reader.bytes(1))[0] ?? 0 : -1;
    if (rest < 0) throw new UpstreamError('protocol_error');
    await reader.bytes(rest + 2);
  } finally {
    reader.release();
  }
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', () => reject(new UpstreamError('connect_failed')));
  });
}

function openTls(raw: Socket, servername: string, ca: string | Buffer | undefined): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const tls = tlsConnect({ socket: raw, ...(isIP(servername) === 0 ? { servername } : {}), ...(ca === undefined ? {} : { ca }), rejectUnauthorized: true });
    tls.once('secureConnect', () => resolve(tls));
    tls.once('error', () => reject(new UpstreamError('tls_failed')));
  });
}

/** Ouvre un tunnel vers `target` par le proxy amont ; rend le flux prêt à porter les octets du navigateur. */
export async function dialUpstream(upstream: ResolvedUpstream, target: UpstreamTarget, options: UpstreamDialerOptions = {}): Promise<Socket> {
  const timeoutMs = options.connectTimeoutMs ?? 10_000;
  let raw: Socket | undefined;
  let stream: Socket | undefined;
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new UpstreamError('timeout')), timeoutMs);
  });
  const establish = async (): Promise<Socket> => {
    // Socket créé avant toute attente : le délai dépassé le détruit même en cours de connexion.
    raw = netConnect({ host: upstream.address, port: upstream.port });
    await connected(raw);
    raw.on('error', () => {});
    stream = upstream.type === 'https' ? await openTls(raw, upstream.host, options.ca) : raw;
    if (upstream.type === 'socks5') await socksTunnel(stream, upstream, target);
    else await connectTunnel(stream, upstream, target);
    if (stream !== raw) (stream as Socket & { [WIRE_SOCKET]?: Socket })[WIRE_SOCKET] = raw;
    return stream;
  };
  try {
    return await Promise.race([establish(), deadline]);
  } catch (error) {
    stream?.destroy();
    raw?.destroy();
    throw error instanceof UpstreamError ? error : new UpstreamError('connect_failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Relais de l'egress d'une session (`SessionEgressDeps.dialUpstream`) sur un proxy amont résolu. */
export function createUpstreamDialer(upstream: ResolvedUpstream, options: UpstreamDialerOptions = {}): (target: UpstreamTarget) => Promise<Socket> {
  return (target) => dialUpstream(upstream, target, options);
}
