// SPDX-License-Identifier: AGPL-3.0-only
// Attente du MinIO jetable des tests s3 (revue de browser-v1, point 4) : sous contention Docker, la ligne de journal de
// l'image Bitnami arrivait après l'échéance de 120 s alors que le serveur répondait. La santé HTTP (`/minio/health/live`)
// décide désormais : prêt quand elle tient sans interruption (le serveur provisoire de Bitnami répond quelques secondes puis
// s'arrête), ou dès la ligne de fin de configuration avec un serveur sain. Horloge simulée : aucun conteneur ici.
import { describe, expect, test } from 'vitest';
import { waitMinioReady, type MinioProbe } from './minio.testkit.js';

/** Horloge et serveur simulés : `health(t)` dit si le serveur répond à l'instant t, `logs(t)` ce que `docker logs` rend. */
function simulated(health: (t: number) => boolean, logs: (t: number) => string = () => '') {
  let now = 0;
  const probe: MinioProbe = {
    now: () => now,
    sleep: async (ms) => void (now += ms),
    healthy: async () => {
      now += 50;
      return health(now);
    },
    logs: () => {
      now += 200;
      return logs(now);
    },
  };
  return probe;
}

describe('waitMinioReady', () => {
  test('ligne de journal absente ou tardive (contention) : la santé HTTP stable suffit, bien avant l’échéance', async () => {
    const probe = simulated((t) => t > 20_000);
    await expect(waitMinioReady(probe, { deadlineMs: 120_000 })).resolves.toBeLessThan(40_000);
  });

  test('serveur provisoire (sain 3 s puis arrêté) : on attend le serveur définitif', async () => {
    const probe = simulated((t) => (t > 1_000 && t < 4_000) || t > 9_000);
    const readyAt = await waitMinioReady(probe, { deadlineMs: 120_000 });
    expect(readyAt).toBeGreaterThan(9_000);
  });

  test('ligne de fin de configuration et serveur sain : prêt sans attendre la stabilité', async () => {
    const probe = simulated((t) => t > 6_000, (t) => (t > 6_000 ? 'minio 12:00:00.00 INFO  ==> ** MinIO setup finished! **' : ''));
    const readyAt = await waitMinioReady(probe, { deadlineMs: 120_000 });
    expect(readyAt).toBeLessThan(9_000);
  });

  test('jamais sain : échec à l’échéance, message clair', async () => {
    await expect(waitMinioReady(simulated(() => false), { deadlineMs: 30_000 })).rejects.toThrow(/MinIO : serveur non prêt dans les 30 s/);
  });
});
