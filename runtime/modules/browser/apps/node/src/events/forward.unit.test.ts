// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.5 : les événements de l'egress (1.5) partent vers `session_events` (puits injecté, PostgreSQL en production) dans
// leur ordre d'émission, sans jamais bloquer ni faire échouer l'egress ; un échec d'écriture est signalé, pas levé.
import { describe, expect, test } from 'vitest';
import type { SessionEventSink } from '@sym-browser/core';
import { forwardEgressEvents } from './index.js';

const SESSION = '00000000-0000-4000-8000-0000000000a1';

describe('forwardEgressEvents', () => {
  test('ordre d’émission conservé même si les écritures ont des durées différentes ; horodatage d’émission', async () => {
    const written: { type: string; data: unknown; at?: Date }[] = [];
    let n = 0;
    const sink: SessionEventSink = {
      append: async (event) => {
        await new Promise((r) => setTimeout(r, n++ === 0 ? 30 : 1));
        written.push({ type: event.type, data: event.data, ...(event.at === undefined ? {} : { at: event.at }) });
      },
    };
    const forward = forwardEgressEvents(SESSION, sink, () => undefined);
    const before = Date.now();
    forward.onEvent({ type: 'egress.blocked', data: { host: 'a.test', reason: 'domain_not_allowed', count: 1 } });
    forward.onEvent({ type: 'egress.budget_exceeded', data: { budgetBytes: 1, bytesIn: 2, bytesOut: 0, action: 'cut' } });
    forward.onEvent({ type: 'egress.blocked', data: { host: 'a.test', reason: 'budget_exceeded', count: 3 } });
    await forward.flush();
    expect(written.map((w) => w.type)).toEqual(['egress.blocked', 'egress.budget_exceeded', 'egress.blocked']);
    expect(written.every((w) => (w.at?.getTime() ?? 0) >= before && (w.at?.getTime() ?? 0) <= Date.now())).toBe(true);
  });

  test('échec d’écriture : signalé à onError, les écritures suivantes continuent, rien n’est levé vers l’egress', async () => {
    const errors: unknown[] = [];
    const written: string[] = [];
    let first = true;
    const sink: SessionEventSink = {
      append: async (event) => {
        if (first) {
          first = false;
          throw new Error('base indisponible');
        }
        written.push(event.type);
      },
    };
    const forward = forwardEgressEvents(SESSION, sink, (error) => errors.push(error));
    expect(() => forward.onEvent({ type: 'egress.blocked', data: { host: 'a.test', reason: 'egress_closed', count: 1 } })).not.toThrow();
    forward.onEvent({ type: 'egress.blocked', data: { host: 'b.test', reason: 'egress_closed', count: 1 } });
    await forward.flush();
    expect(errors).toHaveLength(1);
    expect(written).toEqual(['egress.blocked']);
  });
});
