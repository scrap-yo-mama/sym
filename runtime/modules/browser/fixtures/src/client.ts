// SPDX-License-Identifier: AGPL-3.0-only
// Clients minimaux des proxys de test (HTTP absolu, HTTP CONNECT, SOCKS5 avec identifiants), pour les tests : renvoient
// statut, en-têtes et corps d'une requête GET faite à travers le proxy.
import { request as httpRequest } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Credentials } from './config.ts';

export interface ProxyAddress {
  port: number;
  host?: string;
}
export interface Target {
  host: string;
  port: number;
}
export interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const proxyHost = (proxy: ProxyAddress): string => proxy.host ?? '127.0.0.1';
const basic = (credentials: Credentials): string => `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;

function parseResponse(raw: Buffer): Reply {
  const split = raw.indexOf('\r\n\r\n');
  const head = raw.subarray(0, split === -1 ? raw.length : split).toString('utf8').split('\r\n');
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? '')?.[1] ?? 0);
  const headers: Record<string, string> = {};
  for (const line of head.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, headers, body: split === -1 ? '' : raw.subarray(split + 4).toString('utf8') };
}

/** Envoie un GET HTTP/1.1 sur un socket déjà tunnelé et lit la réponse jusqu'à la fermeture. */
function rawGet(socket: Socket, target: Target, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('close', () => resolve(parseResponse(Buffer.concat(chunks))));
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\nConnection: close\r\n\r\n`);
  });
}

export function getViaHttpProxy(proxy: ProxyAddress, credentials: Credentials | undefined, target: Target, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `${target.host}:${target.port}` };
    if (credentials) headers['proxy-authorization'] = basic(credentials);
    const req = httpRequest({ host: proxyHost(proxy), port: proxy.port, method: 'GET', path: `http://${target.host}:${target.port}${path}`, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const flat: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) flat[name] = Array.isArray(value) ? value.join(', ') : (value ?? '');
        resolve({ status: res.statusCode ?? 0, headers: flat, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

export function getViaHttpConnect(proxy: ProxyAddress, credentials: Credentials | undefined, target: Target, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `${target.host}:${target.port}` };
    if (credentials) headers['proxy-authorization'] = basic(credentials);
    const req = httpRequest({ host: proxyHost(proxy), port: proxy.port, method: 'CONNECT', path: `${target.host}:${target.port}`, headers, agent: false });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, headers: {}, body: '' });
        return;
      }
      rawGet(socket, target, path).then(resolve, reject);
    });
    req.on('error', reject);
    req.end();
  });
}

function readExactly(socket: Socket, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= count) {
        socket.off('data', onData);
        socket.off('close', onClose);
        if (buffer.length > count) socket.unshift(buffer.subarray(count));
        resolve(buffer.subarray(0, count));
      }
    };
    const onClose = (): void => reject(new Error('socks5 closed'));
    socket.on('data', onData);
    socket.once('close', onClose);
  });
}

/** Négociation SOCKS5 seule : `none` annonce uniquement « sans authentification ». */
export async function socks5Handshake(proxy: ProxyAddress, auth: Credentials | 'none'): Promise<'ok' | 'no_acceptable_method' | 'auth_failed'> {
  const socket = connect({ host: proxyHost(proxy), port: proxy.port });
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  try {
    socket.write(Buffer.from(auth === 'none' ? [0x05, 0x01, 0x00] : [0x05, 0x02, 0x00, 0x02]));
    const choice = await readExactly(socket, 2);
    if (choice[1] === 0xff) return 'no_acceptable_method';
    if (auth === 'none') return 'ok';
    const user = Buffer.from(auth.username);
    const pass = Buffer.from(auth.password);
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    const status = await readExactly(socket, 2);
    return status[1] === 0x00 ? 'ok' : 'auth_failed';
  } finally {
    socket.destroy();
  }
}

export async function getViaSocks5(proxy: ProxyAddress, credentials: Credentials, target: Target, path: string): Promise<Reply> {
  const socket = connect({ host: proxyHost(proxy), port: proxy.port });
  await new Promise<void>((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  try {
    socket.write(Buffer.from([0x05, 0x01, 0x02]));
    if ((await readExactly(socket, 2))[1] !== 0x02) throw new Error('socks5 method refused');
    const user = Buffer.from(credentials.username);
    const pass = Buffer.from(credentials.password);
    socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
    if ((await readExactly(socket, 2))[1] !== 0x00) throw new Error('socks5 auth refused');
    const isIpv4 = /^\d+\.\d+\.\d+\.\d+$/.test(target.host);
    const address = isIpv4 ? Buffer.from([0x01, ...target.host.split('.').map(Number)]) : Buffer.concat([Buffer.from([0x03, Buffer.byteLength(target.host)]), Buffer.from(target.host)]);
    const port = Buffer.alloc(2);
    port.writeUInt16BE(target.port);
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), address, port]));
    const answer = await readExactly(socket, 10);
    if (answer[1] !== 0x00) throw new Error(`socks5 reply 0x${(answer[1] ?? 0).toString(16).padStart(2, '0')}`);
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return rawGet(socket, target, path);
}
