import { buildServer } from './app.js';

const port = Number(process.env['PORT'] ?? 3000);
const host = process.env['HOST'] ?? '0.0.0.0';

const app = buildServer({ logger: true });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'arrêt du serveur');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
