// SPDX-License-Identifier: AGPL-3.0-only
// U1.11 : consignes des rôles pour la qualité visible des données (UX-22, UX-25, UX-27).
import { describe, expect, test } from 'vitest';
import { EXTRACT_SYSTEM_PROMPT, extractMessages } from './agent-extract.js';
import { HTML_COMPILE_SYSTEM_PROMPT } from './html-compile.js';
import { investigateMessages } from './investigate.js';

describe('UX-22 : l’extracteur sait lire les liens donnés par le texte', () => {
  test('la consigne dit comment lire « texte (URL) » et interdit d’inventer une URL', () => {
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/text \(URL\)/);
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/URL or link field/i);
    expect(EXTRACT_SYSTEM_PROMPT).toMatch(/never invent, build or guess a URL/i);
  });
  test('le texte de la page reste encadré tel quel, liens compris', () => {
    const messages = extractMessages({ instruction: 'offres et lien', pageText: 'Designer (https://jobs.zz-test.example/qonto/1)', pageUrl: 'https://jobs.zz-test.example/qonto?session=zz', truncated: false }, 'tok');
    const user = String(messages[1]!.content);
    expect(user).toContain('Designer (https://jobs.zz-test.example/qonto/1)');
    expect(user).toContain('SOURCE: https://jobs.zz-test.example/qonto');
    expect(user).not.toContain('session=zz');
  });
});

describe('UX-27 : la compilation préfère la valeur complète à l’affichage coupé', () => {
  test('la consigne cite l’attribut title et « ... »', () => {
    expect(HTML_COMPILE_SYSTEM_PROMPT).toMatch(/cut with "\.\.\."/);
    expect(HTML_COMPILE_SYSTEM_PROMPT).toMatch(/title|aria-label/);
  });
});

describe('UX-25 : le schéma précédent est l’ancre de la proposition', () => {
  const base = { description: 'livres', candidates: [] } as const;
  test('sans schéma précédent : aucune ligne', () => {
    expect(String(investigateMessages({ ...base }, 'tok')[1]!.content)).not.toContain('PREVIOUS OUTPUT SCHEMA');
  });
  test('avec schéma précédent : noms et types donnés, consigne de les garder', () => {
    const previousSchema = { type: 'object', properties: { title: { type: 'string' }, price: { type: 'number' } } };
    const user = String(investigateMessages({ ...base, previousSchema }, 'tok')[1]!.content);
    expect(user).toContain('PREVIOUS OUTPUT SCHEMA');
    expect(user).toContain('"price":{"type":"number"}');
    expect(user).toMatch(/keep the same field names/i);
  });
  test('borné : un schéma énorme est coupé', () => {
    const previousSchema = { type: 'object', properties: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`field_${i}`, { type: 'string', description: 'x'.repeat(40) }])) };
    const user = String(investigateMessages({ ...base, previousSchema }, 'tok')[1]!.content);
    expect(user.length).toBeLessThan(30_000);
  });
});
