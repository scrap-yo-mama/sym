// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm brand:sync` : copie .github/assets/brand/ vers apps/docs/content/public/brand/ ; `--check` : échoue si la copie est périmée.
import { brandDrift, brandSync } from './lib/brand-sync.ts';

if (process.argv.includes('--check')) {
  const drift = brandDrift();
  if (drift.length > 0) {
    console.error(`apps/docs/content/public/brand/ n'est pas à jour (${drift.join(', ')}) : lancer \`pnpm brand:sync\`.`);
    process.exit(1);
  }
  console.log('apps/docs/content/public/brand/ est à jour.');
} else {
  for (const name of brandSync()) console.log(`copié : ${name}`);
}
