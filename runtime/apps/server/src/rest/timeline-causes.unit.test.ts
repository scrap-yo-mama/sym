// SPDX-License-Identifier: AGPL-3.0-only
// U1.12 : la chronologie (`timeline[]` de get_run) porte la cause exacte d'un échec : champ et raison du contenu minimal
// (UX-21), classe d'erreur du moteur agentique (UX-23), différentiel par champ d'une compilation refusée (UX-37), cause et
// raison de la fin d'enquête (UX-15). Valeurs filtrées : codes et noms de champs seulement (assert_reason_matches_cause).
import { describe, expect, test } from 'vitest';
import { buildTimeline, type EventRow, type TimelineAttempt, type TimelineCompile, type TimelineFinished } from './timeline.js';

let seq = 0;
const ev = (kind: string, payload: Record<string, unknown>): EventRow => ({ seq: (seq += 1), kind, payload, at: new Date(Date.parse('2026-10-05T10:00:00Z') + seq * 100) });
const attempt = (why: Record<string, unknown>): EventRow =>
  ev('attempt.finished', { attempt: { execution: 'fetch', network: 'direct', est_cost_usd: 0.0001, result: 'extraction', cost_usd: 0.0001, ms: 90 }, executions: [{ ok: true, records: 20, pages: 1 }], why });

describe('timeline : cause exacte des essais (UX-21, UX-23)', () => {
  test('minimal_content : champ et raison publiés', () => {
    seq = 0;
    const entry = buildTimeline([attempt({ code: 'minimal_content', params: { field: 'in_stock', reason: 'constant' } })], 'zz').find((e) => e.kind === 'attempt') as TimelineAttempt;
    expect(entry.why).toEqual({ code: 'minimal_content', reason: 'constant', params: { field: 'in_stock', reason: 'constant' } });
  });
  test('moteur agentique : la classe d’erreur est publiée', () => {
    seq = 0;
    const entry = buildTimeline([attempt({ code: 'agent_engine_error', params: { class: 'chromium_launch_signal' } })], 'zz').find((e) => e.kind === 'attempt') as TimelineAttempt;
    expect(entry.why).toMatchObject({ code: 'agent_engine_error', params: { class: 'chromium_launch_signal' } });
  });
  test('un paramètre qui n’a pas la forme d’un code ou d’un nom de champ n’est jamais recopié', () => {
    seq = 0;
    const entry = buildTimeline([attempt({ code: 'minimal_content', params: { field: 'Prénom de Anna <script>', reason: 'https://zz-test.example/?q=zz', class: 'Ligne libre', autre: 'zz' } })], 'zz').find((e) => e.kind === 'attempt') as TimelineAttempt;
    expect(JSON.stringify(entry)).not.toMatch(/Anna|script|zz-test|Ligne libre|autre/);
  });
  test('sans paramètre : pas de clé params', () => {
    seq = 0;
    const entry = buildTimeline([attempt({ code: 'agent_request_blocked', params: {} })], 'zz').find((e) => e.kind === 'attempt') as TimelineAttempt;
    expect(entry.why).toEqual({ code: 'agent_request_blocked', reason: null });
  });
});

describe('timeline : compilation refusée par champ (UX-37)', () => {
  test('entrée compile : écart d’ensemble, écarts par champ et deux exemples', () => {
    seq = 0;
    const events = [
      ev('strategy.compiled', {
        ok: false,
        reason: 'values',
        expected: 57,
        got: 57,
        ratio: 0.7368,
        fields: [{ field: 'agency', compared: 57, mismatched: 15, examples: [{ expected: 'Siège', got: 'Agence Nord' }, { expected: 'Siège 2', got: 'Agence Sud' }, { expected: 'x', got: 'y' }] }, { field: 'name', compared: 57, mismatched: 12, examples: [], masked: true }],
      }),
    ];
    const entry = buildTimeline(events, 'zz').find((e) => e.kind === 'compile') as TimelineCompile;
    expect(entry).toMatchObject({ ok: false, reason: 'values', expected: 57, got: 57, ratio: 0.7368 });
    expect(entry.fields[0]).toEqual({ field: 'agency', compared: 57, mismatched: 15, examples: [{ expected: 'Siège', got: 'Agence Nord' }, { expected: 'Siège 2', got: 'Agence Sud' }] });
    expect(entry.fields[1]).toMatchObject({ field: 'name', masked: true, examples: [] });
  });
  test('une compilation réussie n’entre pas dans la chronologie', () => {
    seq = 0;
    expect(buildTimeline([ev('strategy.compiled', { ok: true, records: 57, ratio: 1 })], 'zz').some((e) => e.kind === 'compile')).toBe(false);
  });
});

describe('timeline : fin d’enquête avec sa cause exacte (UX-15)', () => {
  test('detail et raison de la fin sont publiés', () => {
    seq = 0;
    const entry = buildTimeline([ev('investigation.finished', { outcome: 'failed', failure_class: 'code_error', detail: 'llm_settings_unreadable', detail_params: { reason: 'key_unreadable' } })], 'zz').find((e) => e.kind === 'finished') as TimelineFinished;
    expect(entry).toMatchObject({ failure_class: 'code_error', detail: 'llm_settings_unreadable', detail_params: { reason: 'key_unreadable' } });
  });
});

describe('U1.11 : qualité visible, dite par la chronologie (UX-25, UX-26)', () => {
  test('schéma proposé : champs perdus, ajoutés, retypés et renommages probables (noms de champs seulement)', () => {
    seq = 0;
    const entry = buildTimeline(
      [ev('schema.proposed', { ok: true, output_schema: { properties: { job_title: {}, price_gbp: {} } }, changes: { dropped: ['title', 'price'], added: ['job_title', 'price_gbp'], retyped: [], renamed: [{ from: 'price', to: 'price_gbp' }, { from: 'Prénom <b>', to: 'x' }] } })],
      'zz',
    ).find((e) => e.kind === 'schema') as { changes?: unknown };
    expect(entry.changes).toEqual({ dropped: ['title', 'price'], added: ['job_title', 'price_gbp'], retyped: [], renamed: [{ from: 'price', to: 'price_gbp' }] });
  });
  test('schéma sans changement : pas de clé changes', () => {
    seq = 0;
    const entry = buildTimeline([ev('schema.proposed', { ok: true, output_schema: { properties: { a: {} } } })], 'zz').find((e) => e.kind === 'schema') as { changes?: unknown };
    expect(entry.changes).toBeUndefined();
  });
  test('fin d’enquête : pages demandées et ce qui en a été fait', () => {
    seq = 0;
    const done = (outcome: string) => buildTimeline([ev('investigation.finished', { outcome: 'conformant', items: 20, pages_requested: { pages: 3, outcome } })], 'zz').find((e) => e.kind === 'finished') as TimelineFinished;
    expect(done('max_pages_default').pages_requested).toEqual({ pages: 3, outcome: 'max_pages_default' });
    expect(done('not_paginated').pages_requested).toEqual({ pages: 3, outcome: 'not_paginated' });
    expect(done('autre chose').pages_requested).toBeUndefined();
  });
});
