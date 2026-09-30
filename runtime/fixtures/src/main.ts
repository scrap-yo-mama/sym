// Point d'entrée de `pnpm fixtures` : FIXTURES_PORT (défaut 4010), FIXTURES_TOKEN, FIXTURES_SEED.
import { DEFAULT_SEED, DEFAULT_TOKEN, startFixtureServer } from './server.ts';

const port = Number(process.env['FIXTURES_PORT'] ?? 4010);
const server = await startFixtureServer({
  port,
  token: process.env['FIXTURES_TOKEN'] ?? DEFAULT_TOKEN,
  seed: Number(process.env['FIXTURES_SEED'] ?? DEFAULT_SEED),
});

console.log(`fixtures : ${server.hosts.length} hôtes virtuels sur http://127.0.0.1:${server.port} (boucle locale uniquement)`);
for (const host of server.hosts) console.log(`  http://${host}:${server.port}/`);
console.log('commandes : GET /health, POST /__reset, GET /__stats, GET /__sites, POST /__control (en-tête x-zz-test-token)');

const stop = (): void => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
