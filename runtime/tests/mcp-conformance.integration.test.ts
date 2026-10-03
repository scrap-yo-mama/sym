// SPDX-License-Identifier: AGPL-3.0-only
// Suite de conformité MCP officielle (15 § 6, tâche 3.2) : @modelcontextprotocol/conformance, version ÉPINGLÉE au
// catalogue, jouée contre un vrai serveur (base migrée), aux exigences des révisions 2026-07-28 (sans état) et 2025-11-25
// (repli sans état du SDK v2). Les scénarios qui exigent les outils, ressources et prompts de démonstration de la suite
// (`test_simple_text`, `test://…`) n'ont pas d'équivalent dans SYM : ils sont listés, chacun commenté, dans
// tests/mcp-conformance/expected-failures-<révision>.yaml. La suite échoue sur toute régression ET sur toute entrée devenue inutile.
// La conformité n'est proclamée qu'à la hauteur des scénarios couverts (15 § 6, spec encore « à valider »).
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createKey, runSetup, signIn, startTestServer, type TestServer } from './helpers/server.js';

const runtimeDir = new URL('..', import.meta.url).pathname;
// Binaire de la version épinglée au catalogue (résolu depuis ce paquet, jamais téléchargé à l'exécution).
const CLI = join(dirname(fileURLToPath(import.meta.resolve('@modelcontextprotocol/conformance/package.json'))), 'dist/index.js');
const baseline = (revision: string) => join(runtimeDir, `tests/mcp-conformance/expected-failures-${revision}.yaml`);

/** Contrôles en échec de chaque scénario (identifiant et message), pour le diagnostic d'une régression. */
function failedChecks(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'checks.json') {
        const checks = JSON.parse(readFileSync(full, 'utf8')) as { id?: string; name?: string; status?: string; errorMessage?: string }[];
        for (const c of checks) if (c.status === 'FAILURE') out.push(`${d.split('/').at(-1)} : ${c.id ?? c.name} : ${(c.errorMessage ?? '').slice(0, 300)}`);
      }
    }
  };
  walk(dir);
  return out.join('\n');
}

let srv: TestServer;
let proxy: Server;
let url: string;

beforeAll(async () => {
  srv = await startTestServer('mcpconf', { MCP_ALLOWED_HOSTS: '127.0.0.1', MCP_ALLOWED_ORIGINS: '127.0.0.1', MAX_WAIT_SECONDS: '1' });
  const owner = await runSetup(srv);
  const cookie = await signIn(srv, owner);
  const { key } = await createKey(srv, cookie, owner, ['apis:read', 'apis:run', 'apis:write', 'runs:read', 'datasets:read']);
  const target = new URL(await srv.app.listen({ port: 0, host: '127.0.0.1' }));
  // La suite n'envoie pas d'identifiant : un relais local ajoute la clé, sans toucher aux autres en-têtes (Host, Origin
  // et corps arrivent tels que la suite les a écrits, scénario de rebinding DNS compris).
  proxy = createServer((req, res) => {
    const upstream = httpRequest(
      { host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, authorization: `Bearer ${key}` } },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/mcp`;
}, 180_000);

afterAll(async () => {
  proxy.closeAllConnections();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await srv.close();
});

describe('suite de conformité MCP officielle (version épinglée, écarts attendus commentés)', () => {
  test.each(['2026-07-28', '2025-11-25'])('exigences de la révision %s : vert hors écarts attendus, aucun écart périmé', async (revision) => {
    // Processus enfant ASYNCHRONE : le serveur et le relais tournent dans ce processus (une attente synchrone les bloquerait).
    // Résultats (checks.json par scénario) écrits dans un dossier temporaire, jamais dans le dépôt.
    const dir = mkdtempSync(join(tmpdir(), 'zz-test-mcp-conformance-'));
    const run = await new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [CLI, 'server', '--url', url, '--requirements', revision, '--expected-failures', baseline(revision), '-o', dir], {
        cwd: dir,
        env: { ...process.env, NO_COLOR: '1' },
      });
      let out = '';
      child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
      child.on('close', (status) => resolve({ status, out }));
    });
    expect(run.status, `${run.out.slice(-3000)}\n${failedChecks(dir)}`).toBe(0);
  }, 360_000);
});
