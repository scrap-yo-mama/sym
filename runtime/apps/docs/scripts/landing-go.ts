// SPDX-License-Identifier: AGPL-3.0-only
// Porte du GO de mise en ligne de la landing (⚠️ GO, 22 § 4) : ce que le code sait encore refuser (preuve non livrée, champ
// juridique à fournir, entrée du registre non relue) et ce que seul un humain confirme. Hors ci:local : elle est rouge tant que le
// produit n'est pas livré, par construction. Lecture seule, rien n'est publié.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goBlockers, isRealTestIn } from '../src/landing/checks.ts';
import { loadClaims } from '../src/landing/claims.ts';
import { buildLanding } from '../src/landing/content.ts';
import { LEGAL_PATHS, LEGAL_REFERENCE_LANGUAGE } from '../src/landing/href.ts';
import { buildInputs, readStars, siteEnv } from '../src/landing/site.ts';
import { LANGS } from '../src/landing/types.ts';

const docsDir = fileURLToPath(new URL('..', import.meta.url));
const runtimeDir = join(docsDir, '..', '..');

function testFiles(dir: string): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'dist', 'dist-preprod', 'coverage', '.git'].includes(entry.name) || entry.name.startsWith('dist-')) return [];
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return /\.(test|e2e)\.ts$/.test(entry.name) ? [{ file: full, text: readFileSync(full, 'utf8') }] : [];
  });
}

const inputs = buildInputs(siteEnv(process.env, '/sym/'));
const displayed = [...new Set(LANGS.flatMap((lang) => buildLanding(lang, inputs).claims))];
const corpus = testFiles(runtimeDir);
const legalSources = LANGS.flatMap((lang) => Object.values(LEGAL_PATHS[lang])).map((path) => ({ file: `content/${path}.md`, text: readFileSync(join(docsDir, 'content', `${path}.md`), 'utf8') }));
const { blockers, manual } = goBlockers({ registry: loadClaims(), displayed, legalSources, isRealTest: (name) => isRealTestIn(corpus, name), version: readStars().version, legalReferenceLanguage: LEGAL_REFERENCE_LANGUAGE });

console.log(`Porte du GO de la landing : ${blockers.length} bloquant(s), ${manual.length} vérification(s) humaine(s).`);
for (const blocker of blockers) console.log(`  BLOQUANT  ${blocker}`);
for (const item of manual) console.log(`  À CONFIRMER  ${item}`);
process.exitCode = blockers.length === 0 ? 0 : 1;
