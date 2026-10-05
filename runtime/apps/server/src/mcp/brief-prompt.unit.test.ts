// SPDX-License-Identifier: AGPL-3.0-only
// Faire compiler le dossier par l'IA (tâche 2.14, 19c § 8) : description du champ `brief` (premier canal), phrase des
// `instructions` (47 caractères, sous le plafond de 1 000) et partie « dossier » du prompt `new_api` (environ 900
// caractères, en anglais), enregistrée comme prompt MCP par 3.10.
import { describe, expect, test } from 'vitest';
import { BRIEF_SCHEMA, estimateTokens, GENERIC_TOOLS, MCP_INSTRUCTIONS, NEW_API_BRIEF_PROMPT } from './tools.js';

describe('dossier d’enquête dans les textes MCP (19c § 8)', () => {
  test('description du champ brief : ce que SYM en fait, sans élargissement ni secret ; champ < 500 jetons estimés', () => {
    expect(BRIEF_SCHEMA['description']).toBe('Optional. What you already found about this site, as typed hints and what you tried. SYM checks each hint and may ignore it. It never widens access or budgets. No cookies, tokens or personal data. Keep it under 6 KB.');
    const create = GENERIC_TOOLS.find((t) => t.name === 'create_api')!;
    expect((create.inputSchema['properties'] as Record<string, unknown>)['brief']).toBe(BRIEF_SCHEMA);
    expect(estimateTokens(JSON.stringify(BRIEF_SCHEMA))).toBeLessThan(500);
  });

  test('instructions : « Before create_api, put what you found in brief. », toujours sous 1 000 caractères', () => {
    expect(MCP_INSTRUCTIONS).toContain('Before create_api, put what you found in brief.');
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(1000);
  });

  test('prompt new_api (partie dossier, D-115) : environ 800 caractères, en anglais, de ce que la personne a déjà dit, sans navigation ni cookie ni donnée personnelle demandés', () => {
    expect(NEW_API_BRIEF_PROMPT.length).toBeGreaterThan(500);
    expect(NEW_API_BRIEF_PROMPT.length).toBeLessThan(1100);
    for (const part of ['hints:', 'tried:', 'open_questions:', 'SYM checks every hint itself', 'No cookies, tokens, passwords or personal data', 'omit brief']) expect(NEW_API_BRIEF_PROMPT).toContain(part);
    expect(NEW_API_BRIEF_PROMPT).not.toMatch(/__NEXT_DATA__|JSON-LD|spend a few tool calls/);
    expect(NEW_API_BRIEF_PROMPT).toMatch(/Do not open the page/);
  });
});
