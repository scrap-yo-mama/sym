// SPDX-License-Identifier: AGPL-3.0-only
// Proxy SOCKS5 de test avec identifiants : RFC 1928 (négociation, CONNECT, adresses IPv4, IPv6 et nom) et RFC 1929
// (utilisateur/mot de passe). La méthode « sans authentification » est refusée (0xFF). Journal : IP du client, utilisateur,
// cible, issue ; jamais le mot de passe. L'IP vue par la cible est celle du conteneur (10.88.0.12 en Docker Compose).
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net';
import { isIPv6 } from 'node:net';
import { credentialsMatch, type ProxyHandle, type ProxyOptions } from './http-proxy.ts';
import { createJournal, normalizeIp } from './journal.ts';
import type { ProxyEvent } from './http-proxy.ts';

/** Lecteur d'octets séquentiel au-dessus d'un socket. */
function reader(socket: Socket): { read(count: number): Promise<Buffer>; rest(): Buffer } {
  let buffer = Buffer.alloc(0);
  let waiting: { count: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | undefined;
  const flush = (): void => {
    if (waiting && buffer.length >= waiting.count) {
      const { count, resolve } = waiting;
      waiting = undefined;
      const out = buffer.subarray(0, count);
      buffer = buffer.subarray(count);
      resolve(out);
    }
  };
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    flush();
  });
  const fail = (): void => waiting?.reject(new Error('closed'));
  socket.on('close', fail);
  socket.on('error', fail);
  return {
    read: (count) =>
      new Promise((resolve, reject) => {
        waiting = { count, resolve, reject };
        flush();
      }),
    rest: () => {
      const out = buffer;
      buffer = Buffer.alloc(0);
      return out;
    },
  };
}

const REP_GENERAL = 0x01;
const REP_HOST_UNREACHABLE = 0x04;
const REP_REFUSED = 0x05;
const REP_COMMAND_UNSUPPORTED = 0x07;
const REP_ATYP_UNSUPPORTED = 0x08;

const reply = (code: number): Buffer => Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);

export async function startSocks5Proxy(options: ProxyOptions): Promise<ProxyHandle> {
  const journal = createJournal<ProxyEvent>(10_000, options.onEvent);
  const sockets = new Set<Socket>();

  const session = async (client: Socket): Promise<void> => {
    const clientIp = normalizeIp(client.remoteAddress);
    const log = (user: string, target: string, outcome: string): void => journal.add({ at: new Date().toISOString(), clientIp, user, method: 'CONNECT', target, outcome });
    const input = reader(client);

    const [version, methodCount] = await input.read(2).then((b) => [b[0], b[1]] as const);
    if (version !== 0x05) return void client.destroy();
    const methods = await input.read(methodCount ?? 0);
    if (!methods.includes(0x02)) {
      log('', '', 'no_acceptable_method');
      client.end(Buffer.from([0x05, 0xff]));
      return;
    }
    client.write(Buffer.from([0x05, 0x02]));

    const authHead = await input.read(2);
    const userBytes = await input.read(authHead[1] ?? 0);
    const passLength = (await input.read(1))[0] ?? 0;
    const passBytes = await input.read(passLength);
    const username = userBytes.toString('utf8');
    if (authHead[0] !== 0x01 || !credentialsMatch(options.credentials, username, passBytes.toString('utf8'))) {
      log(username, '', 'auth_failed');
      client.end(Buffer.from([0x01, 0x01]));
      return;
    }
    client.write(Buffer.from([0x01, 0x00]));

    const [, command, , atyp] = await input.read(4);
    let host: string;
    if (atyp === 0x01) host = [...(await input.read(4))].join('.');
    else if (atyp === 0x03) host = (await input.read((await input.read(1))[0] ?? 0)).toString('utf8');
    else if (atyp === 0x04) {
      const raw = await input.read(16);
      host = Array.from({ length: 8 }, (_, i) => raw.readUInt16BE(i * 2).toString(16)).join(':');
    } else {
      log(username, '', 'atyp_unsupported');
      client.end(reply(REP_ATYP_UNSUPPORTED));
      return;
    }
    const port = (await input.read(2)).readUInt16BE(0);
    const target = `${isIPv6(host) ? `[${host}]` : host}:${port}`;
    if (command !== 0x01) {
      log(username, target, 'command_unsupported');
      client.end(reply(REP_COMMAND_UNSUPPORTED));
      return;
    }

    const upstream = connect({ host, port });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    let established = false;
    upstream.once('connect', () => {
      established = true;
      log(username, target, 'ok');
      client.write(reply(0x00));
      const early = input.rest();
      if (early.length > 0) upstream.write(early);
      client.removeAllListeners('data');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (error: NodeJS.ErrnoException) => {
      if (!established) {
        log(username, target, 'upstream_error');
        client.end(reply(error.code === 'ECONNREFUSED' ? REP_REFUSED : error.code === 'ENOTFOUND' || error.code === 'EHOSTUNREACH' ? REP_HOST_UNREACHABLE : REP_GENERAL));
      } else client.destroy();
    });
  };

  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    session(client).catch(() => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host ?? '0.0.0.0', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    journal,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
