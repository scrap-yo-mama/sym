// SPDX-License-Identifier: AGPL-3.0-only
// Verrou de construction du site de doc : deux builds VitePress du même dossier en parallèle (les tests de contrat de la doc, ceux
// de la landing, le préproduction E2E) se marchent dessus (cache de VitePress, pages générées). Un dossier créé atomiquement, propre
// au dossier apps/docs, sert de verrou ; un verrou de plus de quinze minutes est tenu pour abandonné.
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STALE_MS = 15 * 60_000;

export async function withBuildLock<T>(docsDir: string, run: () => T | Promise<T>): Promise<T> {
  const lock = join(tmpdir(), `zz_test_docs-build-${createHash('sha256').update(docsDir).digest('hex').slice(0, 12)}.lock`);
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // le verrou vient d'être libéré : on réessaie tout de suite
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    return await run();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}
