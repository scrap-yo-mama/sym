// SPDX-License-Identifier: AGPL-3.0-only
// Job promptfoo du banc (N1, N2) : réseau Docker INTERNE créé pour le job (aucune route hors de l'hôte), promptfoo dans son
// image épinglée qui appelle POST /case pour chaque tâche, chaque modèle et chaque répétition, puis sortie JSON relue en
// enregistrements du banc. Point d'accès du banc joignable depuis le réseau interne :
// - Docker sur Linux (`gateway`) : point d'accès lié à la seule passerelle du réseau interne, adresse de l'hôte ;
// - Docker Desktop (macOS, Windows : la passerelle vit dans la VM, `listen` y échoue en EADDRNOTAVAIL) (`relay`) : point
//   d'accès sur 127.0.0.1 de l'hôte, et un conteneur RELAIS (même image, `node`) à deux pattes, réseau interne et réseau
//   `bridge`, qui ne fait que transmettre le TCP reçu sur son port vers ce seul point d'accès (host.docker.internal). Le
//   conteneur promptfoo reste sur le seul réseau interne, sans route par défaut : il ne joint que le relais.
// Réseau, relais et point d'accès sont retirés à la fin, même en cas d'échec.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePromptfooOutput, PROMPTFOO_IMAGE, promptfooConfig, promptfooDockerArgs } from './promptfoo.ts';
import type { BenchLevel, BenchRecord } from './records.ts';

/** Ce que le point d'accès sait faire : jouer un cas pour un modèle (le harnais du banc, ou un bouchon en test d'image). */
export type CaseRunner = (caseId: string, modelId: string, level: BenchLevel) => Promise<BenchRecord>;

export interface PromptfooJob {
  records: BenchRecord[];
  network: { name: string; internal: boolean; gateway: string; via: 'gateway' | 'relay' };
  exitCode: number;
}

/** Port du relais dans son conteneur. */
const RELAY_PORT = 8080;
/** Relais TCP minimal (aucune dépendance) : tout ce qui arrive sur RELAY_PORT va vers T_HOST:T_PORT, rien d'autre. */
const RELAY_SCRIPT = `const net=require('net');const h=process.env.T_HOST,p=Number(process.env.T_PORT);net.createServer(c=>{const u=net.connect(p,h);c.pipe(u);u.pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy());}).listen(${RELAY_PORT},'0.0.0.0',()=>console.log('RELAY_READY'));`;

function run(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => child.kill('SIGTERM'), options.timeoutMs);
    child.once('error', reject);
    child.once('close', (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('corps trop grand');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

/** Point d'accès du banc : POST /case { task_id, model_id, level } → enregistrement ; liés à une seule adresse. */
async function startBenchEndpoint(options: { host: string; level: BenchLevel; models: readonly string[]; cases: readonly string[]; runCase: CaseRunner }): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== 'POST' || req.url !== '/case') {
          res.writeHead(404).end();
          return;
        }
        const body = (await readBody(req)) as { task_id?: unknown; model_id?: unknown; level?: unknown };
        if (typeof body.task_id !== 'string' || !options.cases.includes(body.task_id) || typeof body.model_id !== 'string' || !options.models.includes(body.model_id) || body.level !== options.level) {
          res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown_case' }));
          return;
        }
        const record = await options.runCase(body.task_id, body.model_id, options.level);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(record));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, options.host, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://${options.host}:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const addressNotAvailable = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'EADDRNOTAVAIL';

/** Relais du réseau interne vers le point d'accès de l'hôte (Docker Desktop) ; rend l'URL vue depuis le réseau interne. */
async function startRelay(docker: string, name: string, network: string, hostPort: number): Promise<string> {
  const started = await run(docker, ['run', '-d', '--name', name, '--network', 'bridge', '--add-host', 'host.docker.internal:host-gateway', '-e', 'T_HOST=host.docker.internal', '-e', `T_PORT=${hostPort}`, '--entrypoint', 'node', PROMPTFOO_IMAGE, '-e', RELAY_SCRIPT]);
  if (started.code !== 0) throw new Error(`relais du banc non démarré : ${started.stderr.trim()}`);
  const connected = await run(docker, ['network', 'connect', network, name]);
  if (connected.code !== 0) throw new Error(`relais du banc non relié au réseau interne : ${connected.stderr.trim()}`);
  const deadline = Date.now() + 60_000;
  while (!(await run(docker, ['logs', name])).stdout.includes('RELAY_READY')) {
    if (Date.now() > deadline) throw new Error('relais du banc : pas prêt en 60 s');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const inspect = JSON.parse((await run(docker, ['inspect', name])).stdout) as { NetworkSettings: { Networks: Record<string, { IPAddress?: string }> } }[];
  const ip = inspect[0]?.NetworkSettings.Networks[network]?.IPAddress;
  if (ip === undefined || ip === '') throw new Error(`relais du banc : aucune adresse sur ${network}`);
  return `http://${ip}:${RELAY_PORT}`;
}

/** Joue les cas sous promptfoo dans Docker, sur un réseau interne créé pour l'occasion. */
export async function runPromptfooJob(options: { level: BenchLevel; models: readonly string[]; cases: readonly string[]; descriptions?: Record<string, string>; repeat: number; runCase: CaseRunner; docker?: string }): Promise<PromptfooJob> {
  const docker = options.docker ?? 'docker';
  const name = `zz_sym_eval_${randomBytes(4).toString('hex')}`;
  const created = await run(docker, ['network', 'create', '--internal', name]);
  if (created.code !== 0) throw new Error(`réseau Docker interne non créé : ${created.stderr.trim()}`);
  const dir = mkdtempSync(join(tmpdir(), 'zz-sym-eval-'));
  let endpoint: { url: string; close(): Promise<void> } | undefined;
  const relay = `${name}_relay`;
  let via: 'gateway' | 'relay' = 'gateway';
  try {
    const inspect = JSON.parse((await run(docker, ['network', 'inspect', name])).stdout) as { Internal: boolean; IPAM: { Config: { Gateway?: string }[] } }[];
    const internal = inspect[0]?.Internal === true;
    const gateway = inspect[0]?.IPAM.Config.find((c) => c.Gateway !== undefined)?.Gateway;
    if (!internal || gateway === undefined) throw new Error(`réseau ${name} : interne et passerelle attendus`);
    const endpointOptions = { level: options.level, models: options.models, cases: options.cases, runCase: options.runCase };
    let url: string;
    try {
      endpoint = await startBenchEndpoint({ host: gateway, ...endpointOptions });
      url = endpoint.url;
    } catch (error) {
      // Docker Desktop : la passerelle du réseau interne n'est pas une adresse de l'hôte. Relais (voir l'en-tête).
      if (!addressNotAvailable(error)) throw error;
      via = 'relay';
      endpoint = await startBenchEndpoint({ host: '127.0.0.1', ...endpointOptions });
      url = await startRelay(docker, relay, name, Number(new URL(endpoint.url).port));
    }
    const cfg = mkdtempSync(join(dir, 'cfg-'));
    const out = mkdtempSync(join(dir, 'out-'));
    // L'utilisateur du conteneur (promptfoo) lit la configuration et écrit la sortie : dossiers temporaires ouverts à lui, retirés à la fin.
    chmodSync(dir, 0o755);
    chmodSync(cfg, 0o755);
    chmodSync(out, 0o777);
    const tasks = options.cases.map((id) => ({ id, description: options.descriptions?.[id] ?? id }));
    writeFileSync(join(cfg, 'promptfooconfig.yaml'), promptfooConfig({ tasks, endpoint: url, level: options.level, models: options.models }).yaml);
    const args = promptfooDockerArgs({ network: name, configDir: cfg, outDir: out, repeat: options.repeat });
    // Conteneur nommé : retiré à la fin même si le client docker est arrêté par le délai.
    args.splice(2, 0, '--name', name);
    const result = await run(docker, args, { timeoutMs: 6 * 3_600_000 });
    let output: unknown;
    try {
      output = JSON.parse(readFileSync(join(out, 'promptfoo.json'), 'utf8'));
    } catch {
      throw new Error(`promptfoo n'a produit aucune sortie (code ${result.code}) : ${result.stderr.slice(-2000)}`);
    }
    return { records: parsePromptfooOutput(output), network: { name, internal, gateway, via }, exitCode: result.code };
  } finally {
    await run(docker, ['rm', '-f', name]);
    if (via === 'relay') await run(docker, ['rm', '-f', relay]);
    await endpoint?.close();
    await run(docker, ['network', 'rm', name]);
    rmSync(dir, { recursive: true, force: true });
  }
}
