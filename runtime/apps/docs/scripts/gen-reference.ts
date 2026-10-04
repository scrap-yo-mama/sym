// SPDX-License-Identifier: AGPL-3.0-only
// Produit les deux pages de référence générées : REST (OpenAPI) et codes de raison (textes de la console).
// Appelé par `pnpm --filter @runtime/docs build` et `dev`. Les fichiers produits ne sont pas versionnés.
import { readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'yaml';
import { renderReasonsReference } from '../src/reasons-reference.ts';
import { renderRestReference, type OpenApiDocument } from '../src/rest-reference.ts';

const here = new URL('../', import.meta.url);
const runtime = new URL('../../', here);

export function generateReference(): { rest: string; reasons: string } {
  const openapi = parse(readFileSync(new URL('packages/client/openapi/openapi.yaml', runtime), 'utf8')) as OpenApiDocument;
  const fr = JSON.parse(readFileSync(new URL('packages/i18n/locales/fr.json', runtime), 'utf8')) as Parameters<typeof renderReasonsReference>[0];
  const spec = (JSON.parse(readFileSync(new URL('apps/web/src/testing/spec-reason-codes.json', runtime), 'utf8')) as { codes: string[] }).codes;
  return { rest: renderRestReference(openapi), reasons: renderReasonsReference(fr, spec) };
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url) {
  const { rest, reasons } = generateReference();
  writeFileSync(new URL('content/reference/rest.md', here), rest);
  writeFileSync(new URL('content/reference/codes-de-raison.md', here), reasons);
  console.log('docs : pages de référence générées (REST, codes de raison).');
}
