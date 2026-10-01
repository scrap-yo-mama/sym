// SPDX-License-Identifier: AGPL-3.0-only
// Toute clé de traduction écrite en toutes lettres dans la console (`t('catalog.title')`, `te(...)`) existe dans les deux
// fichiers de langue ; pour une clé construite (`t(\`status.${x}\`)`), l'espace de noms existe. Garde contre les fautes de
// frappe et les renommages incomplets : un texte manquant s'afficherait sous forme de clé brute.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import en from './locales/en.json';
import fr from './locales/fr.json';

const webSrc = new URL('../', import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : sources(full);
    return /\.(vue|ts)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

function lookup(tree: unknown, path: string[]): unknown {
  return path.reduce<unknown>((node, key) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[key] : undefined), tree);
}

describe('clés de traduction utilisées', () => {
  const literal = /\b(?:t|te)\(\s*(['"`])([A-Za-z0-9_.${}]+)\1/g;

  test('chaque clé du code existe en en et en fr ; une clé construite a son espace de noms', () => {
    let checked = 0;
    for (const file of sources(webSrc)) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(literal)) {
        const key = match[2] ?? '';
        const constant = key.split('.').filter((part) => !part.includes('${'));
        const dynamic = key.includes('${');
        const path = dynamic ? constant.slice(0, key.split('.').findIndex((part) => part.includes('${'))) : constant;
        for (const [name, messages] of [['en', en], ['fr', fr]] as const) {
          const found = lookup(messages, path);
          expect(found, `${file} : ${key} (${name})`).toBeDefined();
          if (!dynamic) expect(typeof found, `${file} : ${key} (${name})`).toBe('string');
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(150);
  });
});
