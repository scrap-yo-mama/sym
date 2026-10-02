// SPDX-License-Identifier: AGPL-3.0-only
// Pilotage de fixtures/compose.yaml par la CLI Docker. Aucun signal envoyé à un processus : seulement `docker compose`.
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface ComposePorts {
  site: number;
  http: number;
  socks5: number;
}
export interface ComposeOptions {
  project: string;
  ports: ComposePorts;
}

const COMPOSE_FILE = fileURLToPath(new URL('../compose.yaml', import.meta.url));
export const DEFAULT_PROJECT = 'sym-browser-fixtures';
export const DEFAULT_PORTS: ComposePorts = { site: 18_080, http: 18_081, socks5: 18_082 };

function docker(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { env, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker ${args.join(' ')} : ${stderr || error.message}`));
      else resolve({ stdout, stderr });
    });
  });
}

export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(['compose', 'version']);
    await docker(['info', '--format', '{{.ServerVersion}}']);
    return true;
  } catch {
    return false;
  }
}

const composeEnv = (ports: ComposePorts): NodeJS.ProcessEnv => ({
  ...process.env,
  FIXTURES_SITE_PORT: String(ports.site),
  FIXTURES_HTTP_PROXY_PORT: String(ports.http),
  FIXTURES_SOCKS5_PORT: String(ports.socks5),
});

const base = (project: string): string[] => ['compose', '-p', project, '-f', COMPOSE_FILE];

/** Construit l'image, démarre site + proxys et attend leurs sondes de santé. */
export async function composeUp({ project, ports }: ComposeOptions): Promise<void> {
  await docker([...base(project), 'up', '--build', '--detach', '--wait', '--wait-timeout', '180'], composeEnv(ports));
}

export async function composeDown({ project, ports }: ComposeOptions): Promise<void> {
  await docker([...base(project), 'down', '--volumes', '--remove-orphans', '--timeout', '5'], composeEnv(ports));
}
