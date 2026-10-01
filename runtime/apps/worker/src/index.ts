import { startWorker } from './worker.js';
import { assertSandboxSupported } from './sandbox/index.js';

// Test de démarrage (08 §3) : refus si isolated-vm est sous la borne GHSA-864f-rcv7-6rh4 ou sans binaire pour ce Node.
assertSandboxSupported();

const worker = startWorker();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    worker.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
