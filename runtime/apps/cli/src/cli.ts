import { readFileSync } from 'node:fs';
import { generateMasterKey, loadKeyring, MasterKeyError } from '@runtime/core';
import pg from 'pg';
import {
  DatabaseConfigError,
  KeyCheckError,
  keyCheck,
  rekey,
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
  '  runtime keygen                       affiche une MASTER_KEY neuve (32 octets base64), sans l’écrire',
  '  runtime key-check                    vérifie MASTER_KEY contre settings.key_check (crée le témoin sur base neuve)',
  '  runtime rekey --confirm [--batch-size N]   rotation : MASTER_KEY (nouvelle) + MASTER_KEY_PREVIOUS (ancienne) ; sauvegarde préalable exigée',
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

async function withSessionClient<T>(deps: CliDeps, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const { sessionUrl } = await resolveConnections(deps.env ?? process.env, deps.probe);
  const client = new pg.Client({ connectionString: sessionUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function keyCheckCmd(deps: CliDeps): Promise<{ code: number; out: string }> {
  const keyring = loadKeyring(deps.env ?? process.env);
  const res = await withSessionClient(deps, (client) => keyCheck(client, keyring));
  const what = res.status === 'initialized' ? 'témoin créé' : 'clé vérifiée';
  return { code: 0, out: `key-check : ${what} (empreinte ${res.fingerprint}, version ${res.version})` };
}

async function rekeyCmd(args: string[], deps: CliDeps): Promise<{ code: number; out: string }> {
  if (!args.includes('--confirm')) {
    return {
      code: 1,
      out: 'rekey : sauvegarde exigée. Faites un pg_dump et conservez l’ancienne clé, puis relancez avec --confirm.',
    };
  }
  const sizeIndex = args.indexOf('--batch-size');
  const batchSize = sizeIndex >= 0 ? Number(args[sizeIndex + 1]) : 100;
  if (!(Number.isInteger(batchSize) && batchSize > 0)) return { code: 1, out: USAGE };
  const keyring = loadKeyring(deps.env ?? process.env, { previous: true });
  const log = deps.log ?? ((line: string) => console.log(line));
  const res = await withSessionClient(deps, (client) =>
    rekey(client, keyring, { batchSize, afterBatch: (n) => log(`rekey : ${n} secret(s) re-chiffré(s)`) }),
  );
  if (res.status === 'already_done') return { code: 0, out: `rekey : rien à faire, la base est déjà sous MASTER_KEY (version ${res.to}).` };
  return {
    code: 0,
    out:
      `rekey : terminé, version ${res.from} → ${res.to}, ${res.rotated} secret(s) re-chiffré(s)` +
      (res.unreadable > 0 ? `, ${res.unreadable} illisible(s) (état unreadable)` : '') +
      (res.rotatedArtifacts + res.unreadableArtifacts > 0 ? `, ${res.rotatedArtifacts} artefact(s) re-chiffré(s)` : '') +
      (res.unreadableArtifacts > 0 ? `, ${res.unreadableArtifacts} artefact(s) illisible(s) marqué(s) (audit artifact.unreadable)` : '') +
      '. MASTER_KEY_PREVIOUS peut être retirée.',
  };
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<{ code: number; out: string }> {
  const [cmd, ...args] = argv;
  if (cmd === '--version' || cmd === '-v') return { code: 0, out: version() };
  if (cmd === 'keygen') return { code: 0, out: generateMasterKey() };
  try {
    if (cmd === 'migrate') return await migrate(args, deps);
    if (cmd === 'key-check') return await keyCheckCmd(deps);
    if (cmd === 'rekey') return await rekeyCmd(args, deps);
  } catch (error) {
    const refusal = error instanceof DatabaseConfigError || error instanceof MasterKeyError || error instanceof KeyCheckError;
    const prefix = refusal ? 'Refus de démarrer' : 'Erreur';
    return { code: 2, out: `${prefix} : ${(error as Error).message}` };
  }
  return { code: 1, out: USAGE };
}
