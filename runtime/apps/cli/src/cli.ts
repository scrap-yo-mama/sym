// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync, writeFileSync } from 'node:fs';
import { generateMasterKey, loadKeyring, MasterKeyError } from '@runtime/core';
import pg from 'pg';
import {
  acceptKeyLossLocked,
  AppRoleError,
  ensureAppRole,
  BackupDeclarationError,
  buildDiagnostics,
  buildOfflineDiagnostics,
  buildUnreadableDiagnostics,
  type Diagnostics,
  DatabaseConfigError,
  declareBackup,
  exportCatalog,
  formatDoctor,
  inspectKeyLoss,
  isConnectionError,
  KeyCheckError,
  keyCheck,
  rekey,
  migrateDown,
  migrateUp,
  resolveConnections,
  runDoctor,
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
  '  runtime doctor [--json]              contrôles locaux (base, schéma, clé, connexions, workers, disque, sauvegarde) ; sortie 0 / 1 (avertissement) / 2 (erreur)',
  '  runtime diagnostics [--out FICHIER]  fichier masqué produit en local, jamais envoyé (à joindre soi-même à un ticket)',
  '  runtime export-catalog [--out FICHIER]   API, schémas, stratégies et planifications en JSON, sans secret ni cookie',
  '  runtime backup declare [--at DATE_ISO]   note qu’une sauvegarde pg_dump vient d’être faite (rappel de doctor)',
  '  runtime restore-prepare              avant pg_restore sur une base vide : recrée le rôle de cluster `runtime_app` (RLS) que le dump n’emporte pas',
  '  runtime secrets accept-key-loss --confirm   MASTER_KEY perdue : secrets conservés « À ressaisir », témoin de clé réécrit',
].join('\n');

export type CliDeps = { env?: NodeJS.ProcessEnv; log?: (line: string) => void; probe?: SessionProbe; now?: () => Date };

/** `stream: 'stdout'` : sortie de données (JSON de doctor) à lire même quand le code de sortie n'est pas 0. */
type CliResult = { code: number; out: string; stream?: 'stdout' };

async function migrate(args: string[], deps: CliDeps): Promise<CliResult> {
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

/** Ouvre la connexion de session. Toute erreur ici est une erreur de configuration ou de connexion. */
async function openSessionClient(deps: CliDeps): Promise<pg.Client> {
  const { sessionUrl } = await resolveConnections(deps.env ?? process.env, deps.probe);
  const client = new pg.Client({ connectionString: sessionUrl });
  await client.connect();
  return client;
}

async function withSessionClient<T>(deps: CliDeps, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await openSessionClient(deps);
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function optionValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Écrit un fichier local en 0600, sans écraser un fichier existant. */
function writeLocalFile(path: string, content: string): void {
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
}

async function doctorCmd(args: string[], deps: CliDeps): Promise<CliResult> {
  const report = await runDoctor({ env: deps.env ?? process.env, ...(deps.probe ? { probe: deps.probe } : {}), ...(deps.now ? { now: deps.now } : {}) });
  const out = args.includes('--json') ? JSON.stringify(report, null, 2) : formatDoctor(report);
  return { code: report.exitCode, out, stream: 'stdout' };
}

function describeRead(d: Diagnostics): string {
  if (!d.database_reachable) return 'base injoignable : contrôles locaux seulement';
  return d.database_read_error ? `base joignable, lecture impossible (${d.database_read_error}) : contrôles locaux seulement` : 'base lue';
}

async function diagnosticsCmd(args: string[], deps: CliDeps): Promise<CliResult> {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const doctor = await runDoctor({ env, ...(deps.probe ? { probe: deps.probe } : {}), now: () => now });
  const input = { env, runtimeVersion: version(), doctor, now };
  // Hors ligne seulement si la base ne se joint pas (ou se coupe). Une lecture en échec sur une base joignable (schéma en
  // retard ou en avance) ne doit pas être présentée comme « injoignable » : le fichier garde `database_reachable: true`.
  const client = await openSessionClient(deps).catch(() => null);
  let diagnostics: Diagnostics;
  if (!client) {
    diagnostics = buildOfflineDiagnostics(input);
  } else {
    try {
      diagnostics = await buildDiagnostics(client, input);
    } catch (error) {
      diagnostics = isConnectionError(error) ? buildOfflineDiagnostics(input) : buildUnreadableDiagnostics(input, error);
    } finally {
      await client.end().catch(() => undefined);
    }
  }
  const path = optionValue(args, '--out') ?? `runtime-diagnostics-${now.toISOString().replace(/[:.]/g, '-')}.json`;
  try {
    writeLocalFile(path, `${JSON.stringify(diagnostics, null, 2)}\n`);
  } catch (error) {
    return { code: 2, out: `Erreur : écriture de ${path} impossible (${(error as NodeJS.ErrnoException).code ?? 'erreur'}) ; le fichier n’est jamais écrasé.` };
  }
  return {
    code: 0,
    out:
      `diagnostics : ${path} écrit (masqué, ${describeRead(diagnostics)}). ` +
      'Rien n’est envoyé : joignez ce fichier vous-même à votre ticket.',
  };
}

async function exportCatalogCmd(args: string[], deps: CliDeps): Promise<CliResult> {
  if (args.includes('--with-secrets')) {
    return {
      code: 1,
      out:
        'export-catalog : --with-secrets n’existe pas en V1. Les secrets ne quittent jamais la base, même chiffrés : ' +
        'ils se ressaisissent sur l’instance cible (décision de 4.6 : docs/exploitation.md, « Décisions et limites de 4.6 »).',
    };
  }
  const catalog = await withSessionClient(deps, (client) => exportCatalog(client, (deps.now ?? (() => new Date()))()));
  const json = `${JSON.stringify(catalog, null, 2)}\n`;
  const path = optionValue(args, '--out');
  if (!path) return { code: 0, out: json.trimEnd(), stream: 'stdout' };
  try {
    writeLocalFile(path, json);
  } catch (error) {
    return { code: 2, out: `Erreur : écriture de ${path} impossible (${(error as NodeJS.ErrnoException).code ?? 'erreur'}) ; le fichier n’est jamais écrasé.` };
  }
  return { code: 0, out: `export-catalog : ${catalog.apis.length} API, ${catalog.projects.length} projet(s) écrits dans ${path} (sans secret ni cookie).` };
}

async function backupCmd(args: string[], deps: CliDeps): Promise<CliResult> {
  if (args[0] !== 'declare') return { code: 1, out: USAGE };
  const raw = optionValue(args, '--at');
  const now = (deps.now ?? (() => new Date()))();
  const at = raw === undefined ? now : new Date(raw);
  const { at: saved } = await withSessionClient(deps, (client) => declareBackup(client, at, now));
  return { code: 0, out: `backup : sauvegarde déclarée au ${saved.toISOString()}. Gardez MASTER_KEY à part du dump (sans elle, les secrets sont illisibles).` };
}

async function restorePrepareCmd(deps: CliDeps): Promise<CliResult> {
  const res = await withSessionClient(deps, (client) => ensureAppRole(client));
  return {
    code: res.member ? 0 : 2,
    out: res.member
      ? `restore-prepare : rôle runtime_app ${res.created ? 'créé' : 'déjà présent'}, accordé à l’utilisateur de la base. Lancez maintenant pg_restore sur cette base vide (docs/exploitation.md).`
      : 'restore-prepare : le rôle runtime_app existe mais l’utilisateur de la base ne peut pas le prendre (droit CREATEROLE manquant ?).',
  };
}

async function secretsCmd(args: string[], deps: CliDeps): Promise<CliResult> {
  if (args[0] !== 'accept-key-loss') return { code: 1, out: USAGE };
  const keyring = loadKeyring(deps.env ?? process.env);
  const current = keyring.current;
  const res = await withSessionClient(deps, async (client) => {
    const state = await inspectKeyLoss(client, current);
    if (state.status === 'no_loss') return { code: 1, out: `accept-key-loss : la clé courante (empreinte ${state.currentFingerprint}) ouvre le témoin de la base : aucune perte à accepter.` };
    if (!args.includes('--confirm')) {
      return {
        code: 1,
        out: [
          `accept-key-loss : la clé courante (empreinte ${state.currentFingerprint}) ne correspond pas à la base (empreinte ${state.expectedFingerprint ?? 'absente'}).`,
          'Si l’ancienne clé est définitivement perdue, relancez avec --confirm. Alors :',
          `  - ${state.secretsReadable} secret(s) passent en « À ressaisir » (conservés, illisibles) ;`,
          `  - ${state.siteSessions} session(s) de site sont vidées (cookies à recapturer), ${state.artifacts} artefact(s) de run supprimés ;`,
          '  - le témoin de clé est réécrit pour la clé courante (la clé d’origine ne sera plus acceptée).',
          'Arrêtez server et worker avant. Si vous avez encore l’ancienne clé, utilisez plutôt `runtime rekey`.',
        ].join('\n'),
      };
    }
    const done = await acceptKeyLossLocked(client, current);
    return {
      code: 0,
      out:
        `accept-key-loss : ${done.unreadable} secret(s) passés en « À ressaisir », ${done.siteSessionsCleared} session(s) de site vidées, ` +
        `${done.artifactsDeleted} artefact(s) supprimés ; témoin de clé réécrit (empreinte ${done.fingerprint}, version ${done.version}).` +
        (done.twoFactorUnreadable > 0
          ? ` ${done.twoFactorUnreadable} graine(s) 2FA marquée(s) illisible(s) : connexion par code de secours puis ré-enrôlement (sans code, un admin réinitialise la 2FA).`
          : '') +
        ' Redémarrez server et worker, puis ressaisissez les secrets dans Réglages.',
    };
  });
  return res;
}

async function keyCheckCmd(deps: CliDeps): Promise<CliResult> {
  const keyring = loadKeyring(deps.env ?? process.env);
  const res = await withSessionClient(deps, (client) => keyCheck(client, keyring));
  const what = res.status === 'initialized' ? 'témoin créé' : 'clé vérifiée';
  return { code: 0, out: `key-check : ${what} (empreinte ${res.fingerprint}, version ${res.version})` };
}

async function rekeyCmd(args: string[], deps: CliDeps): Promise<CliResult> {
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

export async function run(argv: string[], deps: CliDeps = {}): Promise<CliResult> {
  const [cmd, ...args] = argv;
  if (cmd === '--version' || cmd === '-v') return { code: 0, out: version() };
  if (cmd === 'keygen') return { code: 0, out: generateMasterKey() };
  try {
    if (cmd === 'migrate') return await migrate(args, deps);
    if (cmd === 'key-check') return await keyCheckCmd(deps);
    if (cmd === 'rekey') return await rekeyCmd(args, deps);
    if (cmd === 'doctor') return await doctorCmd(args, deps);
    if (cmd === 'diagnostics') return await diagnosticsCmd(args, deps);
    if (cmd === 'export-catalog') return await exportCatalogCmd(args, deps);
    if (cmd === 'backup') return await backupCmd(args, deps);
    if (cmd === 'secrets') return await secretsCmd(args, deps);
    if (cmd === 'restore-prepare') return await restorePrepareCmd(deps);
  } catch (error) {
    const refusal = error instanceof DatabaseConfigError || error instanceof MasterKeyError || error instanceof KeyCheckError;
    const prefix = error instanceof BackupDeclarationError || error instanceof AppRoleError ? 'Refus' : refusal ? 'Refus de démarrer' : 'Erreur';
    return { code: 2, out: `${prefix} : ${(error as Error).message}` };
  }
  return { code: 1, out: USAGE };
}
