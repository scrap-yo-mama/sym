// SPDX-License-Identifier: AGPL-3.0-only
// MinIO jetable pour les tests de l'ObjectStore `s3` : un conteneur par fichier de test, publié sur 127.0.0.1 seulement,
// identifiants aléatoires du run (aucun secret réel), retiré par `docker rm -f <id>` (le seul conteneur créé ici).
// Sans Docker : suite sautée avec un avertissement hors CI, échec sous `CI` (le job doit la faire tourner).
// Point d'accès externe possible : SYMB_TEST_S3_ENDPOINT, SYMB_TEST_S3_ACCESS_KEY_ID, SYMB_TEST_S3_SECRET_ACCESS_KEY.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Secret } from '../crypto/redact.js';
import { S3BlobStore, type S3Options } from './s3-store.js';

/** MinIO 2025-07-23 (image Bitnami « legacy », l'image `minio/minio` n'étant plus distribuée), épinglé par empreinte. */
export const MINIO_IMAGE = 'bitnamilegacy/minio:2025.7.23@sha256:8935e75fa5d11295c17171e4aa49efe390a1193cd7f12e4d21b92af9ffef09d7';

export type S3Fixture = { options: (bucket: string) => S3Options; stop: () => void };

const docker = (args: string[], env?: NodeJS.ProcessEnv) => spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000, env: { ...process.env, ...env } });

export function dockerAvailable(): boolean {
  if (process.env.SYMB_TEST_S3_ENDPOINT) return true;
  return docker(['version', '--format', '{{.Server.Version}}']).status === 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    const port = docker(['port', id, '9000/tcp']).stdout.trim().split('\n')[0]?.split(':').at(-1);
    if (!port) throw new Error('MinIO : port publié introuvable');
    const endpoint = `http://127.0.0.1:${port}`;
    const options = (bucket: string): S3Options => ({ endpoint, bucket, region: 'us-east-1', credentials: { accessKeyId, secretAccessKey: new Secret(secret) } });
    return { options, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

/** Crée le seau, en réessayant tant que MinIO démarre (l'image Bitnami redémarre le serveur après sa configuration). */
export async function createBucket(store: S3BlobStore, deadlineMs = 120_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      await store.createBucket();
      return;
    } catch (error) {
      last = error;
      await sleep(500);
    }
  }
  throw new Error(`MinIO : seau non créé (${(last as Error)?.message ?? 'délai dépassé'})`);
}
