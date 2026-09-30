// SPDX-License-Identifier: AGPL-3.0-only
// Banc SSRF partagé (INV10) : serveur de métadonnées simulé qui compte ses requêtes (doit rester à 0), fixture
// « autorisée », résolveur injecté (rebinding), vecteurs OWASP. Réutilisé par la tâche 2.5 (webhooks).
// Tout tourne en boucle locale, ports éphémères ; aucune adresse publique n'est jamais contactée.
import { createHash } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { createSsrfPolicy, SsrfGuard, type Resolver, type SsrfDenyDetail } from '../../packages/core/src/net/index.ts';

/** Adresse publique renvoyée par le résolveur en phase de validation seulement : jamais contactée. */
export const ZZ_PUBLIC_ADDRESS = '93.184.215.14';

export type SsrfHarness = {
  guard: SsrfGuard;
  metaPort: number;
  fixturePort: number;
  /** Port UDP d'un faux STUN (127.0.0.1) qui compte les paquets reçus (WebRTC). */
  udpPort: number;
  udpPackets(): number;
  /** Connexions et requêtes reçues par le faux service de métadonnées (127.0.0.1 et [::1], même port). */
  metaHits(): number;
  /** WebSocket ouverts sur la fixture autorisée. */
  wsOpens(): number;
  /** Corps des POST reçus par la fixture (webhooks). */
  fixturePosts: string[];
  resolverCalls: Map<string, number>;
  /** Phase du résolveur pour `rebind.zz-test` : `validate` → adresse publique, `connect` → 127.0.0.1. */
  setRebindPhase(phase: 'validate' | 'connect'): void;
  blocked: SsrfDenyDetail[];
  close(): Promise<void>;
};

function listen(server: Server, host = '127.0.0.1', port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function metaServer(count: () => void): Server {
  const meta = createServer((_req, res) => {
    count();
    res.writeHead(200, { 'content-type': 'text/plain' }).end('zz_test_internal_secret');
  });
  meta.on('upgrade', (_req, socket: Duplex) => {
    count();
    socket.destroy();
  });
  meta.on('connection', () => {
    // Une connexion TCP seule (CONNECT tunnelé, WebSocket) compte aussi.
    count();
  });
  return meta;
}

/** Faux service de métadonnées sur 127.0.0.1 et [::1], même port éphémère (quelques essais si le port est pris). */
async function startMeta(count: () => void): Promise<{ servers: Server[]; port: number }> {
  for (let attempt = 0; ; attempt++) {
    const v4 = metaServer(count);
    const port = await listen(v4);
    const v6 = metaServer(count);
    try {
      await listen(v6, '::1', port);
      return { servers: [v4, v6], port };
    } catch (error) {
      await close(v4);
      if (attempt >= 5) throw error;
    }
  }
}

export async function startSsrfHarness(): Promise<SsrfHarness> {
  let hits = 0;
  const { servers: metaServers, port: metaPort } = await startMeta(() => (hits += 1));

  let udpPackets = 0;
  const udp = createSocket('udp4');
  udp.on('message', () => (udpPackets += 1));
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', () => resolve()));
  const udpPort = udp.address().port;

  const fixturePosts: string[] = [];
  const fixture = createServer((req, res) => {
    const target = (path: string) => `http://${path}`;
    const routes: Record<string, string> = {
      '/redirect-meta': target(`127.0.0.1:${metaPort}/latest/meta-data/`),
      '/redirect-meta-name': target(`metadata.zz-test:${metaPort}/latest/meta-data/`),
      '/redirect-imds': target('169.254.169.254/latest/meta-data/iam/security-credentials/'),
      '/redirect-localhost': target(`localhost:${metaPort}/`),
      '/redirect-decimal': target(`2130706433:${metaPort}/`),
      '/redirect-ok': '/',
      '/redirect-cross': target(`fixture2.zz-test:${String(fixtureAddress().port)}/echo`),
      '/redirect-loop': '/redirect-loop',
    };
    const url = req.url ?? '/';
    if (url === '/echo') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ method: req.method, headers: req.headers, body }));
      });
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        fixturePosts.push(body);
        const location = routes[url];
        if (location !== undefined) res.writeHead(307, { location }).end();
        else res.writeHead(204).end();
      });
      return;
    }
    const location = routes[url];
    if (location !== undefined) {
      res.writeHead(302, { location }).end();
      return;
    }
    if (url === '/page') {
      // Sous-ressources et canaux variés vers le faux service de métadonnées : tous doivent être refusés.
      const m = `127.0.0.1:${metaPort}`;
      res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><title>zz_test</title>
<img src="http://${m}/img"><img src="http://localhost:${metaPort}/img2"><img src="http://metadata.zz-test:${metaPort}/img3">
<iframe src="http://[::ffff:127.0.0.1]:${metaPort}/frame"></iframe>
<script>
window.results = [];
const probe = (u) => fetch(u, { mode: 'no-cors' }).then(() => 'ok', () => 'error');
window.done = Promise.all([
  probe('http://${m}/fetch'),
  probe('http://0x7f.0.0.1:${metaPort}/hex'),
  probe('http://0177.0.0.1:${metaPort}/octal'),
  probe('http://169.254.169.254/latest/meta-data/'),
  new Promise((r) => { const ws = new WebSocket('ws://${m}/ws'); ws.onopen = () => r('open'); ws.onerror = () => r('error'); }),
  new Promise((r) => { const ws = new WebSocket('wss://${m}/wss'); ws.onopen = () => r('open'); ws.onerror = () => r('error'); }),
]).then((all) => { window.results = all; return all; });
</script>`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain' }).end('zz_test_ok');
  });
  // WebSocket minimal (poignée de main RFC 6455) pour prouver que ws:// passe par le proxy.
  let wsOpens = 0;
  const upgraded = new Set<Duplex>();
  fixture.on('upgrade', (req, socket: Duplex) => {
    const key = String(req.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    wsOpens += 1;
    upgraded.add(socket);
    socket.on('error', () => socket.destroy());
  });
  const fixtureAddress = () => fixture.address() as AddressInfo;
  const fixturePort = await listen(fixture);

  const resolverCalls = new Map<string, number>();
  let rebindPhase: 'validate' | 'connect' = 'validate';
  const resolver: Resolver = async (host) => {
    resolverCalls.set(host, (resolverCalls.get(host) ?? 0) + 1);
    switch (host) {
      case 'fixture.zz-test':
      case 'fixture2.zz-test':
      case 'metadata.zz-test':
        return [{ address: '127.0.0.1', family: 4 }];
      case 'rebind.zz-test':
        return [{ address: rebindPhase === 'validate' ? ZZ_PUBLIC_ADDRESS : '127.0.0.1', family: 4 }];
      case 'mixed.zz-test':
        return [
          { address: ZZ_PUBLIC_ADDRESS, family: 4 },
          { address: '::1', family: 6 },
        ];
      default:
        throw new Error(`zz_test : nom inconnu ${host}`);
    }
  };

  // Ports des fixtures autorisés : un refus ne peut venir que de l'adresse, jamais du port.
  const guard = new SsrfGuard({
    resolver,
    policy: createSsrfPolicy({
      allowedPrivateHosts: ['fixture.zz-test', 'fixture2.zz-test'],
      allowedPorts: [80, 443, metaPort, fixturePort],
    }),
  });

  return {
    guard,
    metaPort,
    fixturePort,
    udpPort,
    udpPackets: () => udpPackets,
    metaHits: () => hits,
    wsOpens: () => wsOpens,
    fixturePosts,
    resolverCalls,
    setRebindPhase: (phase) => {
      rebindPhase = phase;
    },
    blocked: [],
    close: async () => {
      for (const socket of upgraded) (socket as Socket).destroy();
      for (const server of [...metaServers, fixture]) await close(server);
      await new Promise<void>((resolve) => udp.close(() => resolve()));
    },
  };
}

/** Vecteurs OWASP d'URL visant la boucle locale, le privé ou les métadonnées (tous refusés). */
export function ssrfUrlVectors(metaPort: number): string[] {
  return [
    'http://169.254.169.254/latest/meta-data/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://100.100.100.200/latest/meta-data/',
    `http://127.0.0.1:${metaPort}/`,
    `http://localhost:${metaPort}/`,
    `http://LOCALHOST.:${metaPort}/`,
    `http://app.localhost:${metaPort}/`,
    `http://[::1]:${metaPort}/`,
    `http://[::ffff:127.0.0.1]:${metaPort}/`,
    `http://2130706433:${metaPort}/`,
    `http://0177.0.0.1:${metaPort}/`,
    `http://0x7f.0.0.1:${metaPort}/`,
    `http://127.1:${metaPort}/`,
    `http://0.0.0.0:${metaPort}/`,
    `http://metadata.zz-test:${metaPort}/`,
    `http://mixed.zz-test:${metaPort}/`,
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
  ];
}
