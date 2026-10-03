// SPDX-License-Identifier: AGPL-3.0-only
// MinIO jetable pour les tests de l'ObjectStore `s3` : un conteneur par fichier de test, publié sur 127.0.0.1 seulement,
// identifiants aléatoires du run (aucun secret réel), retiré par `docker rm -f <id>` (le seul conteneur créé ici).
// Sans Docker : suite sautée avec un avertissement hors CI, échec sous `CI` (le job doit la faire tourner).
// Point d'accès externe possible : SYMB_TEST_S3_ENDPOINT, SYMB_TEST_S3_ACCESS_KEY_ID, SYMB_TEST_S3_SECRET_ACCESS_KEY.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Secret } from '../crypto/redact.js';
import type { S3BlobStore, S3Options } from './s3-store.js';

/** MinIO 2025-07-23 (image Bitnami « legacy », l'image `minio/minio` n'étant plus distribuée), épinglé par empreinte. */
const MINIO_IMAGE = 'bitnamilegacy/minio:2025.7.23@sha256:8935e75fa5d11295c17171e4aa49efe390a1193cd7f12e4d21b92af9ffef09d7';

export type S3Fixture = { options: (bucket: string) => S3Options; stop: () => void };

const docker = (args: string[], env?: NodeJS.ProcessEnv) => spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000, env: { ...process.env, ...env } });

export function dockerAvailable(): boolean {
  if (process.env.SYMB_TEST_S3_ENDPOINT) return true;
  return docker(['version', '--format', '{{.Server.Version}}']).status === 0;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Sondes de l'attente (injectables : les tests unitaires simulent l'horloge et le serveur). */
export type MinioProbe = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** `GET /minio/health/live` répond 2xx. */
  healthy: () => Promise<boolean>;
  /** Journaux du conteneur (`docker logs`), lus au plus toutes les `logEveryMs`. */
  logs: () => string;
};

/** Durée de santé ininterrompue exigée : le serveur provisoire de l'image Bitnami répond environ 5 s puis s'arrête. */
const STABLE_HEALTH_MS = 8_000;
const SETUP_FINISHED = /MinIO setup finished/;

/**
 * Attend le serveur MinIO définitif : santé HTTP tenue `STABLE_HEALTH_MS` sans interruption, ou ligne de fin de configuration
 * de l'image avec un serveur sain. Rend l'instant où il est prêt ; échoue à l'échéance (300 s par défaut : sous contention
 * Docker, la configuration a déjà dépassé 120 s).
 */
export async function waitMinioReady(probe: MinioProbe, options: { deadlineMs?: number; pollMs?: number; logEveryMs?: number } = {}): Promise<number> {
  const deadlineMs = options.deadlineMs ?? 300_000;
  const pollMs = options.pollMs ?? 250;
  const logEveryMs = options.logEveryMs ?? 2_000;
  const deadline = probe.now() + deadlineMs;
  let healthySince: number | undefined;
  let lastLogs = -Infinity;
  while (probe.now() <= deadline) {
    const healthy = await probe.healthy();
    healthySince = healthy ? (healthySince ?? probe.now()) : undefined;
    if (healthySince !== undefined && probe.now() - healthySince >= STABLE_HEALTH_MS) return probe.now();
    if (healthy && probe.now() - lastLogs >= logEveryMs) {
      lastLogs = probe.now();
      if (SETUP_FINISHED.test(probe.logs())) return probe.now();
    }
    await probe.sleep(pollMs);
  }
  throw new Error(`MinIO : serveur non prêt dans les ${Math.round(deadlineMs / 1000)} s`);
}

export async function startS3(): Promise<S3Fixture> {
  const external = process.env.SYMB_TEST_S3_ENDPOINT;
  if (external) {
    const accessKeyId = process.env.SYMB_TEST_S3_ACCESS_KEY_ID ?? '';
    const secretAccessKey = new Secret(process.env.SYMB_TEST_S3_SECRET_ACCESS_KEY ?? '');
    return { options: (bucket) => ({ endpoint: external, bucket, region: 'us-east-1', credentials: { accessKeyId, secretAccessKey } }), stop: () => {} };
  }
  const accessKeyId = `symbtest${randomBytes(4).toString('hex')}`;
  const secret = randomBytes(18).toString('base64url');
  const run = docker([
    'run', '-d', '--rm', '-p', '127.0.0.1::9000',
    '-e', `MINIO_ROOT_USER=${accessKeyId}`, '-e', 'MINIO_ROOT_PASSWORD',
    '--label', 'sym-browser.test=objectstore',
    MINIO_IMAGE,
  ], { MINIO_ROOT_PASSWORD: secret });
  // Le mot de passe passe par l'environnement du client docker (`-e NOM` sans valeur), pas par la ligne de commande.
  if (run.status !== 0) throw new Error(`MinIO : démarrage impossible (${run.stderr.trim()})`);
  const id = run.stdout.trim();
  const stop = () => {
    docker(['rm', '-f', id]);
  };
  try {
    // Port publié lu dans la boucle d'attente : sous contention Docker, il n'est pas encore attribué juste après `docker run`.
    let port: string | undefined;
    const publishedPort = (): string | undefined => (port ??= docker(['port', id, '9000/tcp']).stdout.trim().split('\n')[0]?.split(':').at(-1) || undefined);
    // L'image Bitnami lance un serveur provisoire (~5 s), le configure, l'arrête, puis lance le vrai : on attend ce dernier
    // par sa santé HTTP (la ligne de journal seule arrivait après l'échéance sous contention Docker).
    await waitMinioReady({
      now: Date.now,
      sleep,
      healthy: async () => {
        const published = publishedPort();
        if (published === undefined) return false;
        return fetch(`http://127.0.0.1:${published}/minio/health/live`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok, () => false);
      },
      logs: () => {
        const out = docker(['logs', id]);
        return `${out.stdout}${out.stderr}`;
      },
    });
    const endpoint = `http://127.0.0.1:${publishedPort() ?? ''}`;
    const options = (bucket: string): S3Options => ({ endpoint, bucket, region: 'us-east-1', credentials: { accessKeyId, secretAccessKey: new Secret(secret) } });
    return { options, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

/**
 * Crée le seau, en réessayant tant que le serveur définitif démarre (`startS3` a déjà attendu la fin de la configuration de
 * l'image Bitnami, dont le serveur provisoire coupait les connexions sous charge) ; deux succès consécutifs exigés.
 */
const STABLE_PROBES = 2;

export async function createBucket(store: S3BlobStore, deadlineMs = 120_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let last: unknown;
  let stable = 0;
  while (Date.now() < deadline) {
    try {
      await store.createBucket();
      stable += 1;
      if (stable >= STABLE_PROBES) return;
    } catch (error) {
      last = error;
      stable = 0;
    }
    await sleep(500);
  }
  throw new Error(`MinIO : seau non créé (${(last as Error)?.message ?? 'délai dépassé'})`);
}
