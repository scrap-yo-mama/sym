// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm i18n:doc-codes [langue]` : table Markdown des codes de raison depuis `reason.*` (stdout). Les pages bilingues de la doc
// (tâches 4.8 et 4.11) la consomment ; rien n'y est recopié à la main.
import { loadCatalogs, loadRegistry, reasonCodesMarkdown, reasonRows } from '../dist/index.js';

const registry = loadRegistry();
const catalogs = loadCatalogs(registry);
const locale = process.argv[2] ?? 'en';
const heading = locale === 'fr' ? { code: 'Code', label: 'Libellé court', message: 'Phrase' } : { code: 'Code', label: 'Short label', message: 'Sentence' };
process.stdout.write(reasonCodesMarkdown(reasonRows(catalogs, locale), heading));
