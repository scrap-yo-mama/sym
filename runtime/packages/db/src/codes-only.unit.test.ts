// SPDX-License-Identifier: AGPL-3.0-only
// Garde « codes seulement » (21b § 1, M5) dans le chemin d'une enquête : une prose de tiers (détail d'erreur d'un script, texte
// d'un site) qui recoupe le catalogue ne doit pas faire échouer l'enquête. Le mode `scrub` remplace la valeur par un code et
// rend les chemins refusés (à journaliser) au lieu de lever ; le mode par défaut lève toujours.
import { defaultI18n } from '@runtime/i18n';
import { describe, expect, test } from 'vitest';
import { RENDERED_SENTENCE_REMOVED, RenderedSentenceError, assertCodesOnly, scrubRenderedSentences } from './codes-only.js';

describe('assert_events_codes_only_never_fails_investigation', () => {
  const sentence = defaultI18n().renderer.render('narrative.investigation_started', { domain: 'books.example' }, 'fr');

  test('mode par défaut : une phrase du catalogue lève', () => {
    expect(() => assertCodesOnly('investigation_events', { detail: sentence })).toThrow(RenderedSentenceError);
  });

  test('scrub : la phrase est remplacée par un code, le reste de la charge est intact, les chemins sont rendus', () => {
    const payload = { outcome: 'failed', failure_class: 'extraction', detail: `Error: ${sentence}`, nested: { list: ['ok', sentence] }, sample: [{ title: sentence }] };
    const { payload: clean, paths } = scrubRenderedSentences(payload);
    expect(paths).toEqual(['$.detail', '$.nested.list[1]']);
    expect(clean).toEqual({ outcome: 'failed', failure_class: 'extraction', detail: RENDERED_SENTENCE_REMOVED, nested: { list: ['ok', RENDERED_SENTENCE_REMOVED] }, sample: [{ title: sentence }] });
    // La charge d'origine n'est pas modifiée ; le résultat passe la garde stricte.
    expect(payload.detail).toContain(sentence);
    expect(() => assertCodesOnly('investigation_events', clean)).not.toThrow();
    expect(RENDERED_SENTENCE_REMOVED).toMatch(/^[a-z_]+$/);
  });

  test('scrub sans phrase : charge identique, aucun chemin', () => {
    const payload = { phase: 'schema', budget: { spent_usd: 0.01 } };
    expect(scrubRenderedSentences(payload)).toEqual({ payload, paths: [] });
  });
});
