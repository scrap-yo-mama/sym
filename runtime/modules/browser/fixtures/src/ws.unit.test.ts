// SPDX-License-Identifier: AGPL-3.0-only
// WebSocket du site de test : un pair qui ferme sa moitié de connexion (FIN sans trame de fermeture, cas d'un tunnel coupé
// par l'egress ou d'un onglet fermé) ne laisse pas de socket à moitié ouvert ; sinon `site.close()` attendrait sans fin.
import { connect } from 'node:net';
import { expect, test } from 'vitest';
import { startSite } from './site.ts';

test('WebSocket fermé par le pair sans trame de fermeture : le socket du site se ferme, site.close() aboutit', async () => {
  const site = await startSite({ port: 0, host: '127.0.0.1' });
  const socket = connect(site.port, '127.0.0.1');
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
  const greeted = new Promise<string>((resolve) => socket.once('data', (chunk: Buffer) => resolve(chunk.toString('latin1'))));
  socket.write('GET /ws HTTP/1.1\r\nHost: fixtures.local\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  expect(await greeted).toContain('101 Switching Protocols');
  const closedBySite = new Promise<void>((resolve) => socket.once('close', () => resolve()));
  socket.on('data', () => {});
  socket.end();
  const within = (promise: Promise<unknown>, value: string): Promise<string> => Promise.race([promise.then(() => value), new Promise<string>((resolve) => setTimeout(() => resolve('bloqué'), 2_000))]);
  expect(await within(closedBySite, 'fermé par le site')).toBe('fermé par le site');
  expect(await within(site.close(), 'fermé')).toBe('fermé');
});
