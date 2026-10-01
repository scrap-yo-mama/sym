// SPDX-License-Identifier: AGPL-3.0-only
// Crochet pnpm (lu à l'installation) : retire le pair OPTIONNEL `@opentelemetry/api` des paquets qui l'importent ou le
// déclarent sans en avoir besoin, pour qu'OTel coupé ne charge aucun module `@opentelemetry/api` (14 § 10,
// assert_otel_off_by_default). Sans ce retrait, pnpm 11 le relie à la version tirée par @runtime/core (SDK opt-in), et
// Better Auth l'importe à chaque requête d'auth. Rien d'autre n'est modifié ; la liste est fermée.
'use strict';

const STRIP_OTEL_PEER = new Set(['@better-auth/core', 'drizzle-orm', 'vitest']);
const OTEL_API = '@opentelemetry/api';

function readPackage(pkg) {
  if (STRIP_OTEL_PEER.has(pkg.name)) {
    if (pkg.peerDependencies) delete pkg.peerDependencies[OTEL_API];
    if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[OTEL_API];
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
