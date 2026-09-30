// SPDX-License-Identifier: AGPL-3.0-only
import { startWorker } from './worker.js';

const worker = startWorker();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    worker.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
