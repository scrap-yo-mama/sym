// SPDX-License-Identifier: AGPL-3.0-only
// Relevé des refus de l'egress (04c § 1.5) : borne de couples distincts par egress (audit 5.3 : une page qui sollicite des
// milliers de noms refusés ne doit pas écrire des milliers de lignes dans session_events).
import { describe, expect, test } from 'vitest';
import { createBlockedReporter, MAX_DISTINCT_BLOCKED, type EgressEvent } from './events.js';

describe('createBlockedReporter : borne de couples distincts (audit 5.3 S21)', () => {
  test('au-delà de la borne, les hôtes nouveaux sont agrégés sous « * » et aucun refus n’est perdu', () => {
    const events: EgressEvent[] = [];
    const reporter = createBlockedReporter((event) => events.push(event), 60_000);
    const total = MAX_DISTINCT_BLOCKED + 500;
    for (let i = 0; i < total; i++) reporter.report(`h${i}.example`, 'domain_not_allowed', 443);
    reporter.report('h0.example', 'domain_not_allowed', 443);
    reporter.flush();
    const blocked = events.filter((e) => e.type === 'egress.blocked').map((e) => (e as Extract<EgressEvent, { type: 'egress.blocked' }>).data);
    // Une ligne par couple nommé (borne) et une ligne agrégée « * » ; le total des `count` égale les refus.
    expect(new Set(blocked.map((d) => d.host)).size).toBeLessThanOrEqual(MAX_DISTINCT_BLOCKED + 1);
    expect(blocked.some((d) => d.host === '*' && d.reason === 'domain_not_allowed')).toBe(true);
    expect(blocked.reduce((sum, d) => sum + d.count, 0)).toBe(total + 1);
    expect(blocked.length).toBeLessThanOrEqual(MAX_DISTINCT_BLOCKED + 3);
  });

  test('sous la borne : comportement inchangé (première occurrence aussitôt, répétitions agrégées)', () => {
    const events: EgressEvent[] = [];
    const reporter = createBlockedReporter((event) => events.push(event), 60_000);
    reporter.report('a.example', 'domain_not_allowed', 443);
    expect(events).toHaveLength(1);
    reporter.report('a.example', 'domain_not_allowed', 443);
    reporter.report('a.example', 'domain_not_allowed', 443);
    expect(events).toHaveLength(1);
    reporter.flush();
    expect(events).toHaveLength(2);
    expect((events[1] as Extract<EgressEvent, { type: 'egress.blocked' }>).data).toMatchObject({ host: 'a.example', count: 2 });
  });
});
