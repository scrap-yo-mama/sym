// SPDX-License-Identifier: AGPL-3.0-only
// Consignes MCP (3.10, constat Janssens : le client a extrait seul les 519 biens par un script pendant que SYM enquêtait) :
// `instructions` et `create_api` demandent de LAISSER SYM faire l'extraction, de ne pas aller chercher le site soi-même, et
// de suivre `get_run` toutes les `poll_after_seconds` ; pendant une enquête, RunResult porte un indice `progress` lisible.
import { describe, expect, test } from 'vitest';
import { investigationProgress, type TimelineEntry } from '../rest/timeline.js';
import { GENERIC_TOOLS, INSTRUCTIONS_MAX_CHARS, MCP_INSTRUCTIONS, RUN_RESULT_SCHEMA } from './tools.js';

describe('laisser SYM faire l’extraction', () => {
  test('instructions : SYM extrait, le client ne va pas chercher le site, il suit get_run (dans la limite de longueur)', () => {
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
    expect(MCP_INSTRUCTIONS).toContain('Let SYM do the extraction');
    expect(MCP_INSTRUCTIONS).toMatch(/never fetch the site or write a scraper yourself/);
    expect(MCP_INSTRUCTIONS).toMatch(/poll get_run every poll_after_seconds/);
  });

  test('create_api et get_run le répètent ; RunResult déclare progress', () => {
    const tool = (name: string) => GENERIC_TOOLS.find((t) => t.name === name)!;
    expect(tool('create_api').description).toMatch(/SYM does the extraction itself, every page included: do not fetch the site yourself/);
    expect(tool('create_api').description).toMatch(/get_run every poll_after_seconds/);
    expect(tool('get_run').description).toMatch(/progress says what SYM is doing/);
    expect((RUN_RESULT_SCHEMA['properties'] as Record<string, unknown>)['progress']).toBeDefined();
  });
});

describe('indice progress pendant une enquête', () => {
  const start = (phase: string): TimelineEntry => ({ kind: 'investigation', step: 0, slug: 'zz-test', domain: 'zz_test.localhost', phase });
  const attempt = (execution: string, result: string): TimelineEntry => ({ kind: 'attempt', step: 3, execution, network: 'direct', result, records: 10, pages: 1, est_cost_usd: 0.1, cost_usd: 0.16, ms: 40_000 });

  test('pendant les essais : stratégies essayées, dernier essai, phrase pour le client', () => {
    const p = investigationProgress([start('testing'), attempt('fetch', 'extraction'), attempt('agent_fetch', 'ok')]);
    expect(p).toEqual({
      phase: 'testing',
      strategies_tried: 2,
      last_attempt: { execution: 'agent_fetch', network: 'direct', result: 'ok' },
      message: expect.stringMatching(/^SYM is testing extraction strategies, cheapest first: 2 tried \(last: agent_fetch on direct, ok\)\. SYM extracts every page itself: keep polling get_run, do not fetch the site yourself\.$/),
    });
  });

  test('reconnaissance et étape 0 : ce que fait SYM, sans essai', () => {
    expect(investigationProgress([start('reconnaissance')])).toMatchObject({ phase: 'reconnaissance', strategies_tried: 0, last_attempt: null, message: expect.stringContaining('repeated HTML blocks') });
    expect(investigationProgress([])).toMatchObject({ phase: 'investigating', message: expect.stringContaining('checking access') });
  });
});
