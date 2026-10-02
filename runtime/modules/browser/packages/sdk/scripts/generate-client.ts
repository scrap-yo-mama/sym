// SPDX-License-Identifier: MIT
// Génère le client REST du SDK (src/generated/openapi.ts) depuis l'OpenAPI 3.1 du contrat (`browserOpenApi` de
// `@sym/contracts/browser`, tâche 3.4, 04 § 10) : types `paths`, `components`, `operations` par openapi-typescript, puis
// table `OPERATIONS` (méthode, chemin complet, paramètres, corps) lue à l'exécution par le client. `--check` : échoue si le
// fichier committé diffère de la génération ; sans option : réécrit le fichier.
// Usage, depuis runtime/ : `pnpm --filter @sym-browser/sdk gen` (contrat compilé au préalable : `pnpm --filter @sym/contracts build`).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { browserOpenApi } from '@sym/contracts/browser';
import openapiTS, { astToString } from 'openapi-typescript';

export const GENERATED_URL = new URL('../src/generated/openapi.ts', import.meta.url);

const HEADER = [
  '// SPDX-License-Identifier: MIT',
  '// Fichier généré par `pnpm --filter @sym-browser/sdk gen` (scripts/generate-client.ts) depuis `browserOpenApi`',
  '// (@sym/contracts/browser) : ne pas modifier à la main.',
  '',
].join('\n');

const METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;

type Parameter = { name: string; in: 'path' | 'query' | 'header' | 'cookie' };
type Operation = { operationId: string; parameters?: readonly Parameter[]; requestBody?: unknown; security?: readonly unknown[] };
type Spec = { servers?: readonly { url: string }[]; security?: readonly unknown[]; paths: Record<string, Partial<Record<(typeof METHODS)[number], Operation>>> };

/** Table des opérations : une entrée par `operationId`, dans l'ordre de l'OpenAPI. */
function operationTable(spec: Spec): string {
  const base = (spec.servers?.[0]?.url ?? '').replace(/\/+$/, '');
  const lines: string[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (!operation) continue;
      const names = (where: Parameter['in']) => JSON.stringify((operation.parameters ?? []).filter((p) => p.in === where).map((p) => p.name));
      const secured = (operation.security ?? spec.security ?? []).length > 0;
      lines.push(
        `  ${operation.operationId}: { method: '${method.toUpperCase()}', path: '${base}${path}', pathParams: ${names('path')}, query: ${names('query')}, headers: ${names('header')}, body: ${operation.requestBody !== undefined}, auth: ${secured} },`,
      );
    }
  }
  return [
    '',
    '/** Opérations de l’OpenAPI : méthode, chemin complet (serveur compris), paramètres par emplacement, corps JSON, clé requise. */',
    'export const OPERATIONS = {',
    ...lines,
    '} as const;',
    '',
    'export type OperationId = keyof typeof OPERATIONS;',
    '',
  ].join('\n');
}

/** Fichier généré complet (en-tête SPDX compris) pour une OpenAPI donnée. */
export async function renderClient(spec: Spec | typeof browserOpenApi): Promise<string> {
  const types = astToString(await openapiTS(structuredClone(spec) as unknown as Parameters<typeof openapiTS>[0]));
  return `${HEADER}${types}${operationTable(spec as Spec)}`;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const generated = await renderClient(browserOpenApi);
  if (process.argv.includes('--check')) {
    if (!existsSync(GENERATED_URL) || readFileSync(GENERATED_URL, 'utf8') !== generated) {
      console.error('Client du SDK désynchronisé de l’OpenAPI du contrat : lance `pnpm --filter @sym-browser/sdk gen`.');
      process.exit(1);
    }
    console.log('Client du SDK : synchronisé avec l’OpenAPI du contrat.');
  } else {
    writeFileSync(GENERATED_URL, generated);
    console.log(`Client du SDK : ${GENERATED_URL.pathname} écrit.`);
  }
}
