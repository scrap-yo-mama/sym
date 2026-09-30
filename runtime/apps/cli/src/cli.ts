import { readFileSync } from 'node:fs';
import {
  DatabaseConfigError,
  migrateDown,
  migrateUp,
  resolveConnections,
  type SessionProbe,
} from '@runtime/db';

function version(): string {
  const url = new URL('../package.json', import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
}

const USAGE = [
  'Usage :',
  '  runtime --version',
  '  runtime migrate                      applique les migrations en attente (idempotent, sous verrou)',
  '  runtime migrate down [--steps N | --all]   tests et CI seulement (refusé si NODE_ENV=production)',
].join('\n');

export type CliDeps = { env?: NodeJS.ProcessEnv; log?: (line: string) => void; probe?: SessionProbe };

async function migrate(args: string[], deps: CliDeps): Promise<{ code: number; out: string }> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => console.log(line));
  const [sub = 'up', ...rest] = args;
  if (sub !== 'up' && sub !== 'down') return { code: 1, out: USAGE };
  const { sessionUrl } = await resolveConnections(env, deps.probe);
  if (sub === 'up') {
    const { applied } = await migrateUp({ connectionString: sessionUrl, log });
    return { code: 0, out: `migrate : ${applied.length} migration(s) appliquée(s)` };
  }
  const all = rest.includes('--all');
  const stepsIndex = rest.indexOf('--steps');
  const steps = stepsIndex >= 0 ? Number(rest[stepsIndex + 1]) : 1;
  if (!all && !(Number.isInteger(steps) && steps > 0)) return { code: 1, out: USAGE };
  const { reverted } = await migrateDown({ connectionString: sessionUrl, log, env, steps, all });
  return { code: 0, out: `migrate down : ${reverted.length} migration(s) annulée(s)` };
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<{ code: number; out: string }> {
  const [cmd, ...args] = argv;
  if (cmd === '--version' || cmd === '-v') return { code: 0, out: version() };
  try {
    if (cmd === 'migrate') return await migrate(args, deps);
  } catch (error) {
    const prefix = error instanceof DatabaseConfigError ? 'Refus de démarrer' : 'Erreur';
    return { code: 2, out: `${prefix} : ${(error as Error).message}` };
  }
  return { code: 1, out: USAGE };
}
