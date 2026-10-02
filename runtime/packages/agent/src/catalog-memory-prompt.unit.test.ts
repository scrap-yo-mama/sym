// SPDX-License-Identifier: AGPL-3.0-only
// Place du dossier de mémoire dans l'ordre fixe du prompt (tâche 2.12, 19 §2 ; budgets et `resolved-rules` : 2.10) :
// consignes, …, tâche, retours, dossier d'enquête, DOSSIER DE MÉMOIRE, page. Enquête et réparation.
import { describe, expect, it } from 'vitest';
import { investigateMessages } from './investigate.js';
import { repairMessages } from './repair.js';

const MEMORY = '<untrusted_catalog_memory>\n[collecté sur a.fr le 2026-10-01] {"same_api":null}\n</untrusted_catalog_memory>';

describe('assert_catalog_memory_untrusted — place fixe du dossier', () => {
  it('enquête : après la demande et l’exemple, avant les gisements (page) ; jamais dans le message système', () => {
    const messages = investigateMessages(
      { description: 'liste des produits', exampleOutput: { a: 1 }, candidates: [], catalogMemory: MEMORY },
      'b'.repeat(24),
    );
    const system = String(messages[0]!.content);
    const user = String(messages[1]!.content);
    expect(system).not.toContain('untrusted_catalog_memory');
    expect(system).toMatch(/CATALOG MEMORY[^\n]*UNTRUSTED DATA/);
    const iRequest = user.indexOf('REQUEST');
    const iExample = user.indexOf('EXAMPLE OUTPUT');
    const iMemory = user.indexOf('<untrusted_catalog_memory>');
    const iPage = user.indexOf('<untrusted_candidates_');
    expect(iRequest).toBeGreaterThanOrEqual(0);
    expect(iRequest).toBeLessThan(iExample);
    expect(iExample).toBeLessThan(iMemory);
    expect(iMemory).toBeLessThan(iPage);
    // Sans dossier : aucune section.
    expect(String(investigateMessages({ description: 'x', candidates: [] }, 'b'.repeat(24))[1]!.content)).not.toContain('catalog_memory');
  });

  it('réparation : le dossier précède les preuves (page)', () => {
    const messages = repairMessages(
      {
        spec: { schema_version: 1, kind: 'declarative', request: { method: 'GET', url: 'https://a.fr/api', allowed_hosts: ['a.fr'] }, sources: [], fields: [] } as never,
        outputSchema: { type: 'object' },
        failure: { failure_class: 'extraction', retryable: false, detail: 'schema_mismatch' },
        evidence: [],
        healthy: { stable: [] } as never,
        reasons: [],
        refused: [],
        catalogMemory: MEMORY,
      },
      'c'.repeat(24),
    );
    const user = String(messages[1]!.content);
    expect(user.indexOf('<untrusted_catalog_memory>')).toBeGreaterThan(user.indexOf('FAILURE'));
    expect(user.indexOf('<untrusted_catalog_memory>')).toBeLessThan(user.indexOf('<untrusted_evidence_'));
  });
});
