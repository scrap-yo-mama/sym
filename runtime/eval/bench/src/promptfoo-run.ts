// SPDX-License-Identifier: AGPL-3.0-only
// Job promptfoo du banc (N1, N2) : réseau Docker INTERNE créé pour le job (aucune route hors de l'hôte), point d'accès du
// banc lié à la seule passerelle de ce réseau, promptfoo dans son image épinglée qui appelle POST /case pour chaque tâche,
// chaque modèle et chaque répétition, puis sortie JSON relue en enregistrements du banc. Réseau et point d'accès sont
// retirés à la fin, même en cas d'échec.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePromptfooOutput, promptfooConfig, promptfooDockerArgs } from './promptfoo.ts';
import type { BenchLevel, BenchRecord } from './records.ts';

/** Ce que le point d'accès sait faire : jouer un cas pour un modèle (le harnais du banc, ou un bouchon en test d'image). */
export type CaseRunner = (caseId: string, modelId: string, level: BenchLevel) => Promise<BenchRecord>;

export interface PromptfooJob {
  records: BenchRecord[];
  network: { name: string; internal: boolean; gateway: string };
  exitCode: number;
}

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

/** Joue les cas sous promptfoo dans Docker, sur un réseau interne créé pour l'occasion. */
export async function runPromptfooJob(options: { level: BenchLevel; models: readonly string[]; cases: readonly string[]; descriptions?: Record<string, string>; repeat: number; runCase: CaseRunner; docker?: string }): Promise<PromptfooJob> {
  const docker = options.docker ?? 'docker';
  const name = `zz_sym_eval_${randomBytes(4).toString('hex')}`;
  const created = await run(docker, ['network', 'create', '--internal', name]);
  if (created.code !== 0) throw new Error(`réseau Docker interne non créé : ${created.stderr.trim()}`);
  const dir = mkdtempSync(join(tmpdir(), 'zz-sym-eval-'));
  let endpoint: { url: string; close(): Promise<void> } | undefined;
  try {
    const inspect = JSON.parse((await run(docker, ['network', 'inspect', name])).stdout) as { Internal: boolean; IPAM: { Config: { Gateway?: string }[] } }[];
    const internal = inspect[0]?.Internal === true;
    const gateway = inspect[0]?.IPAM.Config.find((c) => c.Gateway !== undefined)?.Gateway;
    if (!internal || gateway === undefined) throw new Error(`réseau ${name} : interne et passerelle attendus`);
    endpoint = await startBenchEndpoint({ host: gateway, level: options.level, models: options.models, cases: options.cases, runCase: options.runCase });
    const cfg = mkdtempSync(join(dir, 'cfg-'));
    const out = mkdtempSync(join(dir, 'out-'));
    // L'utilisateur du conteneur (promptfoo) lit la configuration et écrit la sortie : dossiers temporaires ouverts à lui, retirés à la fin.
    chmodSync(dir, 0o755);
    chmodSync(cfg, 0o755);
    chmodSync(out, 0o777);
    const tasks = options.cases.map((id) => ({ id, description: options.descriptions?.[id] ?? id }));
    writeFileSync(join(cfg, 'promptfooconfig.yaml'), promptfooConfig({ tasks, endpoint: endpoint.url, level: options.level, models: options.models }).yaml);
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
    return { records: parsePromptfooOutput(output), network: { name, internal, gateway }, exitCode: result.code };
  } finally {
    await run(docker, ['rm', '-f', name]);
    await endpoint?.close();
    await run(docker, ['network', 'rm', name]);
    rmSync(dir, { recursive: true, force: true });
  }
}
