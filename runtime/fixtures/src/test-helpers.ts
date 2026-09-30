import { request } from 'node:http';
import { startFixtureServer, type FixtureServer } from './server.ts';

export interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface Client {
  server: FixtureServer;
  call(host: string, method: string, path: string, options?: { headers?: Record<string, string>; body?: string }): Promise<Res>;
  get(host: string, path: string, headers?: Record<string, string>): Promise<Res>;
  json(host: string, path: string, headers?: Record<string, string>): Promise<unknown>;
  control(body: Record<string, unknown>, token?: string): Promise<Res>;
  stats(query?: string): Promise<{ clock: string; total: number; hosts: Record<string, { total: number; paths: Record<string, number> }>; log?: { host: string; path: string; at_ms: number }[] }>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Client HTTP brut : se connecte à 127.0.0.1 et fixe l'hôte virtuel dans l'en-tête Host. */
export async function startClient(seed?: number): Promise<Client> {
  const server = await startFixtureServer({ port: 0, ...(seed === undefined ? {} : { seed }) });
  const call: Client['call'] = (host, method, path, options = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: server.port, method, path, agent: false, headers: { host: `${host}:${server.port}`, ...options.headers } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end(options.body);
    });
  const client: Client = {
    server,
    call,
    get: (host, path, headers) => call(host, 'GET', path, headers ? { headers } : {}),
    json: async (host, path, headers) => JSON.parse((await client.get(host, path, headers)).body) as unknown,
    control: (body, token = server.token) =>
      call('127.0.0.1', 'POST', '/__control', { headers: { 'x-zz-test-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    stats: async (query = '') => JSON.parse((await call('127.0.0.1', 'GET', `/__stats${query}`)).body) as Awaited<ReturnType<Client['stats']>>,
    reset: async () => {
      await call('127.0.0.1', 'POST', '/__reset');
    },
    close: () => server.close(),
  };
  return client;
}
