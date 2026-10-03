// SPDX-License-Identifier: AGPL-3.0-only
// Arrêt gracieux de la passerelle (cdc/sym-browser 04b § 9, tâche 2.7) sur PostgreSQL réel, devant un faux nœud :
//   gateway_shutdown_closes_relays : à la fermeture (SIGTERM → hook Fastify `preClose`), chaque relais WSS ouvert est fermé
//     avec le code 1012 (redémarrage du service) côté client ; la connexion vers le nœud est fermée sans code d'erreur, et la
//     session reste `running` sur son nœud (« laisse les sessions vivre sur les nœuds ») : le client se reconnecte ailleurs.
// Sécurité : aucun processus lancé ici (faux nœud en WebSocket local).
import type { AddressInfo } from 'node:net';
import { ConnectTokens, MasterKey } from '@sym-browser/core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createHarness, type Harness } from '../../test/helpers/harness.js';

const NODE_TOKEN = 'nodetoken-'.repeat(4);
const tokens = new ConnectTokens({ current: MasterKey.generate() });
let wss: WebSocketServer;
const nodeClosed: number[] = [];
let h: Harness;

beforeAll(async () => {
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (info: { req: { headers: Record<string, unknown> } }) => info.req.headers.authorization === `Bearer ${NODE_TOKEN}` });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  wss.on('connection', (socket) => {
    socket.on('message', (data) => socket.send(`echo:${data.toString()}`));
    socket.on('close', (code) => nodeClosed.push(code));
  });
  h = await createHarness({ nodeUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, tokens, relay: { nodeToken: NODE_TOKEN, pingIntervalMs: 60_000 } });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await h?.close();
  await new Promise<void>((resolve) => {
    for (const client of wss?.clients ?? []) client.terminate();
    wss?.close(() => resolve());
  });
});

function open(url: string): Promise<{ ws: WebSocket; closed: Promise<{ code: number; reason: string }>; echo: Promise<string> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const closed = new Promise<{ code: number; reason: string }>((done) => ws.on('close', (code, reason) => done({ code, reason: reason.toString() })));
    const echo = new Promise<string>((done) => ws.once('message', (data) => done(data.toString())));
    ws.once('open', () => resolve({ ws, closed, echo }));
    ws.once('error', reject);
  });
}

describe('gateway_shutdown_closes_relays (04b § 9)', () => {
  test('Given 3 relais ouverts / When arrêt de la passerelle / Then fermés en 1012, nœud détaché proprement, sessions toujours running', async () => {
    const base = `ws://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await h.call({ method: 'POST', url: '/v1/sessions', body: {} })).body.id as string);
    const relays = await Promise.all(ids.map((id) => open(`${base}/v1/sessions/${id}/cdp?token=${tokens.issue({ sessionId: id, protocol: 'cdp', ttlSeconds: 300 })}`)));
    for (const relay of relays) relay.ws.send('ping');
    expect(await Promise.all(relays.map((relay) => relay.echo))).toEqual(['echo:ping', 'echo:ping', 'echo:ping']);

    await h.app.close();

    const closes = await Promise.all(relays.map((relay) => relay.closed));
    for (const close of closes) expect(close.code).toBe(1012);
    const deadline = Date.now() + 3_000;
    while (nodeClosed.length < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(nodeClosed).toHaveLength(3);
    // Pas de code d'erreur vers le nœud : la connexion du client est seulement détachée, la session n'est pas libérée.
    for (const code of nodeClosed) expect([1000, 1001, 1012]).toContain(code);
    const states = await h.pool.query<{ state: string }>('SELECT state FROM sessions WHERE id = ANY($1::uuid[])', [ids]);
    expect(states.rows.map((row) => row.state)).toEqual(['running', 'running', 'running']);
  });
});
