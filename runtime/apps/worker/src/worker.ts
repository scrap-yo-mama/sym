import { pino, type Logger } from 'pino';
import { PACKAGE_NAME as CORE } from '@runtime/core';

export interface Worker {
  stop(): Promise<void>;
}

export function startWorker(
  options: { logger?: Logger; heartbeatMs?: number } = {},
): Worker {
  const log = options.logger ?? pino({ name: 'worker' });
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
