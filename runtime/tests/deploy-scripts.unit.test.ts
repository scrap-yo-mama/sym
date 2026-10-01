// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.1 : les trois scripts de déploiement, sans Docker ni réseau réels. `docker` et `curl` sont remplacés par des
// bouchons dans le PATH ; verify.sh interroge un serveur HTTP local. install.sh écrit son .env à côté de lui : on le copie.
import { MasterKey, generateMasterKey } from '@runtime/core';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const runtimeDir = new URL('..', import.meta.url).pathname;
const deployDir = join(runtimeDir, 'deploy');
const work = mkdtempSync(join(tmpdir(), 'zz_test_deploy-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const sh = (script: string, args: string[], env: Record<string, string>, cwd = work) =>
  new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn('sh', [script, ...args], { cwd, env: { HOME: work, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status: status ?? -1, stdout, stderr }));
  });

function stub(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}
const basePath = (extra: string) => `${extra}:/usr/bin:/bin`;

describe('assert_deploy_scripts : syntaxe, sh -n sur chaque script (dash en CI, sh de macOS en local)', () => {
  for (const script of ['install.sh', 'verify.sh', 'check-image-public.sh']) {
    test(script, () => {
      const res = spawnSync('sh', ['-n', join(deployDir, script)], { encoding: 'utf8' });
      expect(res.stderr).toBe('');
      expect(res.status).toBe(0);
      expect(statSync(join(deployDir, script)).mode & 0o111, 'exécutable').not.toBe(0);
    });
  }
});

describe('install.sh : génère le .env de docker-compose.prod.yml', () => {
  const valid = generateMasterKey();
  const dir = (n: string) => {
    const d = join(work, `install-${n}`);
    mkdirSync(join(d, 'bin'), { recursive: true });
    for (const f of ['install.sh', 'docker-compose.prod.yml']) copyFileSync(join(deployDir, f), join(d, f));
    return d;
  };
  const dockerOk = (d: string) =>
    stub(join(d, 'bin'), 'docker', `echo "$@" >> "${d}/docker.log"\ncase "$1 $2" in "compose version") echo "Docker Compose version v2.0.0" ;; "run --rm") echo "${valid}" ;; esac`);
  const parseEnv = (d: string) => Object.fromEntries(readFileSync(join(d, '.env'), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));

  test('.env en 0600 : MASTER_KEY de `runtime keygen`, jeton ≥ 32 caractères, mot de passe hexadécimal, URL, TRUST_PROXY=1 en https', async () => {
    const d = dir('ok');
    dockerOk(d);
    const res = await sh(join(d, 'install.sh'), ['https://runtime.zz-test.example'], { PATH: basePath(join(d, 'bin')) });
    expect(res.status, res.stderr).toBe(0);
    expect(statSync(join(d, '.env')).mode & 0o777).toBe(0o600);
    const env = parseEnv(d);
    expect(env['MASTER_KEY']).toBe(valid);
    expect(() => MasterKey.parse(env['MASTER_KEY']!)).not.toThrow();
    expect(env['ADMIN_BOOTSTRAP_TOKEN']!.length).toBeGreaterThanOrEqual(32);
    expect(env['POSTGRES_PASSWORD']).toMatch(/^[0-9a-f]{48}$/);
    expect(env['PUBLIC_URL']).toBe('https://runtime.zz-test.example');
    expect(env['TRUST_PROXY']).toBe('1');
    // La commande lancée dans l'image est celle de la spec (`runtime keygen`), sur l'image du fichier compose.
    const log = readFileSync(join(d, 'docker.log'), 'utf8');
    expect(log).toMatch(/run --rm --pull missing ghcr\.io\/mrsoyer\/scrapyomama-runtime:\d+\.\d+\.\d+ runtime keygen/);
  });

  test('aucune valeur secrète n’est affichée ; les commandes à suivre le sont', async () => {
    const d = dir('quiet');
    dockerOk(d);
    const res = await sh(join(d, 'install.sh'), [], { PATH: basePath(join(d, 'bin')) });
    const env = parseEnv(d);
    for (const secret of [env['MASTER_KEY']!, env['ADMIN_BOOTSTRAP_TOKEN']!, env['POSTGRES_PASSWORD']!]) {
      expect(res.stdout + res.stderr).not.toContain(secret);
    }
    expect(res.stdout).toMatch(/docker compose -f .*docker-compose\.prod\.yml.* up -d/);
    expect(res.stdout).toMatch(/Sauvegardez MASTER_KEY/);
    expect(env['PUBLIC_URL']).toBe('http://localhost:3000');
    expect(env['TRUST_PROXY']).toBe('0');
  });

  test('refuse d’écraser un .env existant (une MASTER_KEY remplacée rendrait les secrets illisibles)', async () => {
    const d = dir('exists');
    dockerOk(d);
    writeFileSync(join(d, '.env'), 'MASTER_KEY=ancienne\n');
    const res = await sh(join(d, 'install.sh'), [], { PATH: basePath(join(d, 'bin')) });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/existe déjà/);
    expect(readFileSync(join(d, '.env'), 'utf8')).toBe('MASTER_KEY=ancienne\n');
  });

  test('image injoignable : repli sur openssl, la clé reste canonique (32 octets en base64)', async () => {
    const d = dir('fallback');
    stub(join(d, 'bin'), 'docker', 'case "$1 $2" in "compose version") exit 0 ;; *) exit 1 ;; esac');
    const res = await sh(join(d, 'install.sh'), [], { PATH: basePath(join(d, 'bin')) });
    expect(res.status, res.stderr).toBe(0);
    expect(() => MasterKey.parse(parseEnv(d)['MASTER_KEY']!)).not.toThrow();
  });

  test('sortie parasite de l’image : une valeur qui n’a pas 44 caractères n’est jamais retenue', async () => {
    const d = dir('noise');
    stub(join(d, 'bin'), 'docker', 'case "$1 $2" in "compose version") exit 0 ;; "run --rm") echo "Unable to find image locally" ;; esac');
    const res = await sh(join(d, 'install.sh'), [], { PATH: basePath(join(d, 'bin')) });
    expect(res.status, res.stderr).toBe(0);
    expect(() => MasterKey.parse(parseEnv(d)['MASTER_KEY']!)).not.toThrow();
  });

  test('URL invalide, plugin « docker compose » absent : refus sans écrire de .env', async () => {
    const d = dir('bad');
    dockerOk(d);
    const badUrl = await sh(join(d, 'install.sh'), ['runtime.example.org'], { PATH: basePath(join(d, 'bin')) });
    expect(badUrl.status).toBe(1);
    expect(badUrl.stderr).toMatch(/PUBLIC_URL invalide/);
    stub(join(d, 'bin'), 'docker', 'exit 1');
    const noCompose = await sh(join(d, 'install.sh'), [], { PATH: basePath(join(d, 'bin')) });
    expect(noCompose.status).toBe(1);
    expect(noCompose.stderr).toMatch(/docker compose/);
    expect(existsSync(join(d, '.env'))).toBe(false);
  });
});

describe('verify.sh : sondes d’une instance déployée', () => {
  let server: Server;
  let base = '';
  const behaviour = { readyFailures: 0, ready: 200, mcp: 401, version: '{"server":"0.0.0","schema":11,"min_extension":"0.1.0","mcp_spec":"2025-11-25"}' };
  beforeAll(async () => {
    server = createServer((req, res) => {
      const reply = (code: number, body = '{}') => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(body);
      };
      if (req.url === '/api/health') return reply(200, '{"status":"ok","version":"0.0.0"}');
      if (req.url === '/api/ready') {
        if (behaviour.readyFailures > 0) {
          behaviour.readyFailures -= 1;
          return reply(503, '{"schema":false}');
        }
        return reply(behaviour.ready);
      }
      if (req.url === '/api/version') return reply(200, behaviour.version);
      if (req.url === '/mcp') return reply(behaviour.mcp);
      return reply(404);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const verify = (args: string[] = [], env: Record<string, string> = {}) => sh(join(deployDir, 'verify.sh'), [base, ...args], { PATH: '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin', ...env });
  const reset = () => Object.assign(behaviour, { readyFailures: 0, ready: 200, mcp: 401 });

  test('instance saine : health, ready, version et MCP joignable → code 0', async () => {
    reset();
    const res = await verify();
    expect(res.status, res.stdout).toBe(0);
    expect(res.stdout).toMatch(/\/api\/ready = 200/);
    expect(res.stdout).toMatch(/\/mcp joignable \(HTTP 401/);
    expect(res.stdout).toMatch(/Instance saine/);
  });

  test('/api/ready attend le démarrage : 503 puis 200 → code 0', async () => {
    reset();
    behaviour.readyFailures = 1;
    const res = await verify([], { WAIT: '30' });
    expect(res.status, res.stdout + res.stderr).toBe(0);
  }, 30_000);

  test('/api/ready reste à 503 (schéma, base ou clé) : échec, code 1, message qui renvoie à runtime doctor', async () => {
    reset();
    behaviour.ready = 503;
    const res = await verify([], { WAIT: '1' });
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/ECHEC \/api\/ready = 503/);
    expect(res.stdout).toMatch(/runtime doctor/);
  });

  test('MCP : 404 toléré (version sans serveur MCP) sauf avec --require-mcp ; 5xx toujours un échec', async () => {
    reset();
    behaviour.mcp = 404;
    expect((await verify()).status).toBe(0);
    expect((await verify(['--require-mcp'])).status).toBe(1);
    behaviour.mcp = 502;
    expect((await verify()).status).toBe(1);
  });

  test('usage : URL absente ou invalide → code 2', async () => {
    const res = await sh(join(deployDir, 'verify.sh'), ['pas-une-url'], { PATH: '/usr/bin:/bin' });
    expect(res.status).toBe(2);
  });
});

describe('check-image-public.sh : piège GHCR (paquet privé à la première publication)', () => {
  const script = join(deployDir, 'check-image-public.sh');
  const curlStub = (d: string, token: string, manifestCode: string) =>
    stub(join(d, 'bin'), 'curl', `case "$*" in *ghcr.io/token*) ${token ? `echo '{"token":"${token}"}'` : 'echo \'{"errors":[{"code":"DENIED"}]}\''} ;; *manifests*) printf '${manifestCode}' ;; esac`);
  const dir = (n: string) => {
    const d = join(work, `ghcr-${n}`);
    mkdirSync(join(d, 'bin'), { recursive: true });
    copyFileSync(join(deployDir, 'docker-compose.prod.yml'), join(d, 'docker-compose.prod.yml'));
    copyFileSync(script, join(d, 'check-image-public.sh'));
    return d;
  };

  test('paquet public : jeton anonyme délivré, manifeste en 200 → code 0 (image du fichier compose par défaut)', async () => {
    const d = dir('public');
    curlStub(d, 'anon-token', '200');
    const res = await sh(join(d, 'check-image-public.sh'), [], { PATH: basePath(join(d, 'bin')) });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/se tire sans identifiant/);
  });

  test('paquet privé : pas de jeton anonyme → code 1 et la marche à suivre (« Change package visibility »)', async () => {
    const d = dir('private');
    curlStub(d, '', '401');
    const res = await sh(join(d, 'check-image-public.sh'), ['ghcr.io/mrsoyer/scrapyomama-runtime:1.2.3'], { PATH: basePath(join(d, 'bin')) });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Change package visibility/);
  });

  test('étiquette absente ou paquet encore privé (manifeste en 401/404) → code 1 ; `latest` refusé (code 2)', async () => {
    const d = dir('missing');
    curlStub(d, 'anon-token', '404');
    expect((await sh(join(d, 'check-image-public.sh'), ['ghcr.io/mrsoyer/scrapyomama-runtime:9.9.9'], { PATH: basePath(join(d, 'bin')) })).status).toBe(1);
    expect((await sh(join(d, 'check-image-public.sh'), ['ghcr.io/mrsoyer/scrapyomama-runtime:latest'], { PATH: basePath(join(d, 'bin')) })).status).toBe(2);
    expect((await sh(join(d, 'check-image-public.sh'), ['docker.io/library/nginx:1.0.0'], { PATH: basePath(join(d, 'bin')) })).status).toBe(2);
  });
});
