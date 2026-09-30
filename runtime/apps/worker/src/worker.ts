// SPDX-License-Identifier: AGPL-3.0-only
import { pino, type Logger } from 'pino';
import { loggerRedaction, PACKAGE_NAME as CORE } from '@runtime/core';

export interface Worker {
  stop(): Promise<void>;
}

export function startWorker(
  options: { logger?: Logger; heartbeatMs?: number } = {},
): Worker {
  const log = options.logger ?? pino({ name: 'worker', ...loggerRedaction() }); // masquage INV8, couches 2 et 3
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  log.info({ core: CORE }, 'worker démarré');
  // Le minuteur garde le processus vivant jusqu'à stop().
  const timer = setInterval(() => log.debug('worker en vie'), heartbeatMs);
  return {
    async stop() {
      clearInterval(timer);
      log.info('worker arrêté');
    },
  };
}
