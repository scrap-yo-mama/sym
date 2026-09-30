import { prepareServer } from './start.js';

let started: Awaited<ReturnType<typeof prepareServer>>;
try {
  started = await prepareServer(process.env, { logger: true });
} catch (error) {
  // Message clair, sans pile ni valeur sensible (MASTER_KEY, jeton) : les erreurs de démarrage ne contiennent que des noms.
  console.error(`Démarrage refusé : ${(error as Error).message}`);
  process.exit(1);
}
const { app, config, close } = started;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'arrêt du serveur');
    close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
