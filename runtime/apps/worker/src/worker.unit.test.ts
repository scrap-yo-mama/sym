// SPDX-License-Identifier: AGPL-3.0-only
import { pino } from 'pino';
import { expect, test } from 'vitest';
import { startWorker } from './worker.js';

test('le worker journalise au démarrage et à l’arrêt', async () => {
  const lines: string[] = [];
  const logger = pino({ level: 'info' }, { write: (s: string) => void lines.push(s) });
  const worker = startWorker({ logger, heartbeatMs: 10_000 });
  await worker.stop();
  const msgs = lines.map((l) => (JSON.parse(l) as { msg: string }).msg);
  expect(msgs).toEqual(['worker démarré', 'worker arrêté']);
});
