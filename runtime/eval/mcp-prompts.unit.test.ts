// SPDX-License-Identifier: AGPL-3.0-only
// Jeu de 12 prompts de test du MCP (tâche 3.10, 05 § 4.4, 15 § 11) : forme du fichier et cohérence avec les outils servis.
// Le jeu se joue sur les 4 clients de la matrice (docs/mcp-clients.md) ; ce test garde le fichier lui-même.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { GENERIC_TOOLS } from '../apps/server/src/mcp/tools.js';

type Entry = { id: string; kind: 'direct' | 'indirect' | 'negative'; prompt: string; expected: { tool: string | null; then?: string; refusal?: boolean; reason?: string; args_contain?: Record<string, string> } };
const file = JSON.parse(readFileSync(new URL('./mcp-prompts.json', import.meta.url), 'utf8')) as { tools: string[]; prompts: Entry[] };
const served = GENERIC_TOOLS.map((t) => t.name as string);

describe('eval/mcp-prompts.json : 12 prompts (4 directs, 4 indirects, 4 négatifs)', () => {
  test('12 prompts, 4 de chaque sorte, identifiants uniques, texte borné', () => {
    expect(file.prompts).toHaveLength(12);
    for (const kind of ['direct', 'indirect', 'negative'] as const) expect(file.prompts.filter((p) => p.kind === kind)).toHaveLength(4);
    expect(new Set(file.prompts.map((p) => p.id)).size).toBe(12);
    for (const p of file.prompts) {
      expect(p.prompt.length).toBeGreaterThan(10);
      expect(p.prompt.length).toBeLessThanOrEqual(300);
    }
  });

  test('l’outil attendu est un des 9 outils génériques servis ; un négatif n’en attend aucun, un refus le dit', () => {
    expect([...file.tools].sort()).toEqual([...served].sort());
    for (const p of file.prompts) {
      if (p.kind === 'negative') {
        expect(p.expected.tool, p.id).toBeNull();
        expect(p.expected.reason, p.id).toBeTruthy();
      } else {
        expect(served, p.id).toContain(p.expected.tool);
        if (p.expected.then !== undefined) expect(served, p.id).toContain(p.expected.then);
      }
    }
    // Les demandes de contournement sont des négatifs à refus honnête, jamais servies par un outil.
    const asks = file.prompts.filter((p) => /robots\.txt says no|captcha/i.test(p.prompt));
    expect(asks).toHaveLength(2);
    for (const p of asks) expect(p.expected).toMatchObject({ tool: null, refusal: true });
  });

  test('couvre chaque outil d’exécution et de lecture au moins une fois (hors validate_schema, qui suit create_api)', () => {
    const covered = new Set(file.prompts.flatMap((p) => [p.expected.tool, p.expected.then]).filter((t): t is string => typeof t === 'string'));
    for (const tool of ['list_apis', 'run_api', 'create_api', 'get_items', 'report_problem', 'cancel_run', 'get_api']) expect(covered.has(tool), tool).toBe(true);
  });

  test('aucun site réel, aucun secret, aucun contenu scrapé : domaines zz-books.example seulement', () => {
    const hosts = [...file.prompts.map((p) => p.prompt).join(' ').matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]!.toLowerCase());
    for (const host of hosts) expect(host).toBe('zz-books.example');
  });
});

describe('docs/mcp-clients.md : statut du critère 05 § 4.4 sur les 4 clients', () => {
  test('le jeu de 12 prompts × 4 clients est déclaré reporté à la recette (étape MCP, 15 § 6), cases encore à constater', () => {
    const doc = readFileSync(new URL('../docs/mcp-clients.md', import.meta.url), 'utf8');
    const status = doc.slice(doc.indexOf('## Statut'), doc.indexOf('\n## ', doc.indexOf('## Statut') + 1));
    expect(status).toMatch(/reporté à la recette \(étape MCP\)/);
    expect(status).toContain('15 § 6');
    expect(status).toContain('05 § 4.4');
    expect(status).toMatch(/journal/);
    // Tant que le statut dit « reporté », aucune case n'est remplie sans capture.
    for (const id of file.prompts.map((p) => p.id)) expect(doc).toMatch(new RegExp(`\\| ${id} \\|[^\\n]*à constater`));
  });
});
