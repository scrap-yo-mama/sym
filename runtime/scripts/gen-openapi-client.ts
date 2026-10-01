// SPDX-License-Identifier: AGPL-3.0-only
// Génère les types du client (packages/client/src/generated/schema.ts) depuis l'OpenAPI spécifiée
// (packages/client/openapi/openapi.yaml) avec openapi-typescript. `--check` : échoue si le fichier committé diffère de
// la génération (assert_openapi_client_in_sync) ; sans option : réécrit le fichier. Tâche 3.3 ; rejouée en 3.6 sur
// l'OpenAPI livrée par le serveur (3.1).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import openapiTS, { astToString } from 'openapi-typescript';

const root = new URL('..', import.meta.url);
export const SPEC_URL = new URL('packages/client/openapi/openapi.yaml', root);
export const GENERATED_URL = new URL('packages/client/src/generated/schema.ts', root);

const HEADER = '// SPDX-License-Identifier: MIT\n// Fichier généré par `pnpm gen:openapi` (scripts/gen-openapi-client.ts) : ne pas modifier à la main.\n';

/** Types TypeScript générés depuis une OpenAPI (en-tête SPDX compris). */
export async function generateSchema(spec: URL = SPEC_URL): Promise<string> {
  return HEADER + astToString(await openapiTS(spec));
}

/** True si le fichier généré committé est identique à la génération courante. */
export async function isInSync(spec: URL = SPEC_URL, generated: URL = GENERATED_URL): Promise<boolean> {
  return existsSync(generated) && readFileSync(generated, 'utf8') === (await generateSchema(spec));
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv.includes('--check')) {
    if (!(await isInSync())) {
      console.error('Le client généré est désynchronisé de l’OpenAPI spécifiée : lancez `pnpm gen:openapi`.');
      process.exit(1);
    }
    console.log('Client OpenAPI : synchronisé.');
  } else {
    writeFileSync(GENERATED_URL, await generateSchema());
    console.log(`Client OpenAPI : ${GENERATED_URL.pathname} écrit.`);
  }
}
