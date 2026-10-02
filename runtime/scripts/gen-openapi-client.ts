// SPDX-License-Identifier: AGPL-3.0-only
// Génère, depuis l'OpenAPI spécifiée (packages/client/openapi/openapi.yaml) :
// - les types du client (packages/client/src/generated/schema.ts) avec openapi-typescript (tâche 3.3) ;
// - le document que sert le serveur (apps/server/src/generated/openapi.ts, tâche 3.1) : `/api/openapi.json` en garde les
//   seules opérations enregistrées par le serveur (registre INV12), sans marque `x-pending`.
// `--check` : échoue si un fichier committé diffère de la génération (assert_openapi_client_in_sync) ; sans option :
// réécrit les fichiers. Rejouée en 3.6 sur l'OpenAPI livrée par le serveur.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import openapiTS, { astToString } from 'openapi-typescript';
import { parse } from 'yaml';

const root = new URL('..', import.meta.url);
export const SPEC_URL = new URL('packages/client/openapi/openapi.yaml', root);
export const GENERATED_URL = new URL('packages/client/src/generated/schema.ts', root);
export const SERVER_SPEC_URL = new URL('apps/server/src/generated/openapi.ts', root);

const HEADER = '// SPDX-License-Identifier: MIT\n// Fichier généré par `pnpm gen:openapi` (scripts/gen-openapi-client.ts) : ne pas modifier à la main.\n';

/** Types TypeScript générés depuis une OpenAPI (en-tête SPDX compris). */
export async function generateSchema(spec: URL = SPEC_URL): Promise<string> {
  return HEADER + astToString(await openapiTS(spec));
}

/** Module du serveur : l'OpenAPI spécifiée en JSON (chaîne littérale, relue au démarrage). */
export function generateServerSpec(spec: URL = SPEC_URL): string {
  const document = parse(readFileSync(spec, 'utf8')) as unknown;
  return (
    '// SPDX-License-Identifier: AGPL-3.0-only\n' +
    '// Fichier généré par `pnpm gen:openapi` (scripts/gen-openapi-client.ts) depuis packages/client/openapi/openapi.yaml : ne pas modifier à la main.\n' +
    '/** OpenAPI 3.1 spécifiée, en JSON (`/api/openapi.json` n\'en sert que les opérations livrées). */\n' +
    `export const SPECIFIED_OPENAPI_JSON = ${JSON.stringify(JSON.stringify(document))};\n`
  );
}

/** True si le fichier généré committé est identique à la génération courante. */
export async function isInSync(spec: URL = SPEC_URL, generated: URL = GENERATED_URL): Promise<boolean> {
  return existsSync(generated) && readFileSync(generated, 'utf8') === (await generateSchema(spec));
}

/** True si le document du serveur committé est identique à la génération courante. */
export function isServerSpecInSync(spec: URL = SPEC_URL, generated: URL = SERVER_SPEC_URL): boolean {
  return existsSync(generated) && readFileSync(generated, 'utf8') === generateServerSpec(spec);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (process.argv.includes('--check')) {
    if (!(await isInSync()) || !isServerSpecInSync()) {
      console.error('Le client généré ou le document du serveur est désynchronisé de l’OpenAPI spécifiée : lancez `pnpm gen:openapi`.');
      process.exit(1);
    }
    console.log('Client OpenAPI et document du serveur : synchronisés.');
  } else {
    writeFileSync(GENERATED_URL, await generateSchema());
    mkdirSync(dirname(SERVER_SPEC_URL.pathname), { recursive: true });
    writeFileSync(SERVER_SPEC_URL, generateServerSpec());
    console.log(`Client OpenAPI : ${GENERATED_URL.pathname} et ${SERVER_SPEC_URL.pathname} écrits.`);
  }
}
