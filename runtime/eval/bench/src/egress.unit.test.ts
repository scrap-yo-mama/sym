// SPDX-License-Identifier: AGPL-3.0-only
// Observateur des connexions sortantes du banc (« aucune requête ne quitte l'instance ») : toute tentative de connexion TCP
// du processus est relevée (diagnostics_channel `net.client.socket`, événement `connectionAttempt`), y compris celles qui
// échouent ; seules les adresses de bouclage et les sockets Unix sont locales.
import { createServer, connect, type AddressInfo } from 'node:net';
import { describe, expect, test } from 'vitest';
import { isLocalAddress, observeEgress } from './egress.ts';

describe('observeEgress', () => {
  test('adresses locales : bouclage IPv4 et IPv6, IPv4 mappée ; le reste est distant', () => {
    for (const address of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) expect(isLocalAddress(address), address).toBe(true);
    for (const address of ['192.0.2.1', '10.0.0.1', '172.18.0.1', '2001:db8::1', '::ffff:192.0.2.1']) expect(isLocalAddress(address), address).toBe(false);
  });

  test('relève une connexion locale réussie et une tentative distante échouée', async () => {
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const egress = observeEgress();
    try {
      await new Promise<void>((resolve, reject) => connect(port, '127.0.0.1').once('connect', function (this: { end(): void }) {
        this.end();
        resolve();
      }).once('error', reject));
      // 192.0.2.0/24 (TEST-NET-1, RFC 5737) : jamais routée ; la tentative suffit à être relevée.
      await new Promise<void>((resolve) => {
        const socket = connect({ host: '192.0.2.1', port: 9, timeout: 200 });
        socket.once('timeout', () => socket.destroy());
        socket.once('close', () => resolve());
        socket.once('error', () => undefined);
      });
      expect(egress.connections().some((c) => c.address === '127.0.0.1' && c.port === port)).toBe(true);
      expect(egress.nonLocal()).toEqual([{ address: '192.0.2.1', port: 9 }]);
    } finally {
      egress.stop();
      server.close();
    }
  });
});
