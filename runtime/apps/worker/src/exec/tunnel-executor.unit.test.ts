// SPDX-License-Identifier: AGPL-3.0-only
// Mode réseau `tunnel` côté worker (tâche 2.7, correctifs de vérification), avec une extension simulée (TunnelPort) :
// - correctif 12 (défense en profondeur) : E3 en `page_script`, navigation dont l'URL finale sort du domaine connecté →
//   refus, aucune lecture de la page (`DOM.getDocument` / `DOM.getOuterHTML` jamais envoyées) ;
// - correctif 3 : défi rendu en JSON (XHR DataDome, 403) détecté sur la réponse → `challenge_in_tunnel`, 0 commande ensuite.
import { validateDeclarativeSpec } from '@runtime/core';
import { describe, expect, test } from 'vitest';
import type { TunnelOutcome, TunnelPort } from '../tunnel/client.js';
import { runTunnelExecutor, TunnelSession } from './tunnel-executor.js';

const SHOP = 'zz-test-shop.example';
const RUN = '0e1d2c3b-4a59-4687-9123-abcdefabcdef';
const OWNER = '1e1d2c3b-4a59-4687-9123-abcdefabcdef';
const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string' } },
  additionalProperties: false,
};

function port(answer: (cmd: string, args: Record<string, unknown>) => TunnelOutcome): TunnelPort & { sent: { cmd: string; args: Record<string, unknown> }[] } {
  const sent: { cmd: string; args: Record<string, unknown> }[] = [];
  return {
    sent,
    send: async (input) => {
      sent.push({ cmd: input.cmd, args: input.args as Record<string, unknown> });
      return answer(input.cmd, input.args as Record<string, unknown>);
    },
  };
}

const ok = (body: unknown): TunnelOutcome => ({ kind: 'result', result: { ok: true, error: null, ms: 1, snapshot_id: null, body } });

function spec(input: unknown) {
  const check = validateDeclarativeSpec(input, { outputSchema: SCHEMA });
  if (!check.ok) throw new Error(JSON.stringify(check));
  return check.spec;
}

describe('mode tunnel (worker) : correctifs de vérification', () => {
  test('correctif 12 : URL finale de la navigation hors du domaine connecté → refus, la page n’est jamais lue', async () => {
    const p = port((cmd, args) => (args['method'] === 'Page.navigate' ? ok({ frameId: 'F', status: 200, headers: {}, url: 'https://accounts.google.com/AccountChooser' }) : ok({ root: { nodeId: 1 }, outerHTML: '<p>zz_test_private_user@gmail.example</p>' })));
    const session = new TunnelSession(p, { runId: RUN, ownerId: OWNER, domain: SHOP, allowWriteActions: false, execution: 'playwright' }, new AbortController().signal);
    const out = await runTunnelExecutor({
      session,
      execution: 'playwright',
      spec: spec({
        schema_version: 1,
        kind: 'declarative',
        request: { method: 'GET', url: `https://${SHOP}/catalog`, allowed_hosts: [SHOP] },
        sources: [{ id: 'dom', from: 'html', records: 'article.item' }],
        fields: { id: { css: 'span.id', attr: 'text', type: 'string', required: true } },
      }),
      input: {},
      outputSchema: SCHEMA,
      signal: new AbortController().signal,
    });
    expect(out.result.ok).toBe(false);
    expect(p.sent.map((s) => s.args['method'])).toEqual(['Page.navigate']);
  });

  test('correctif 3 : réponse JSON 403 DataDome (captcha-delivery.com) → challenge_in_tunnel, aucune commande ensuite', async () => {
    const p = port(() =>
      ok({ status: 403, headers: { 'content-type': 'application/json' }, body: '{"url":"https://geo.captcha-delivery.com/captcha/?initialCid=zz_test&t=fe"}', url: `https://${SHOP}/api/search` }),
    );
    const session = new TunnelSession(p, { runId: RUN, ownerId: OWNER, domain: SHOP, allowWriteActions: false, execution: 'fetch' }, new AbortController().signal);
    const out = await runTunnelExecutor({
      session,
      execution: 'fetch',
      spec: spec({
        schema_version: 1,
        kind: 'declarative',
        request: { method: 'POST', url: `https://${SHOP}/api/search`, allowed_hosts: [SHOP], body: { json: { q: 'x' } } },
        sources: [{ id: 'api', from: 'response', format: 'json', records: '$.ads[*]' }],
        fields: { id: { path: '$.id', type: 'string', required: true } },
      }),
      input: {},
      outputSchema: SCHEMA,
      signal: new AbortController().signal,
    });
    expect(out.stop).toBe('challenge_in_tunnel');
    expect(p.sent).toHaveLength(1);
    expect(p.sent[0]).toMatchObject({ cmd: 'page_fetch', args: { method: 'POST' } });
  });
});

describe('U3.4 : tunnel perdu en cours de run (cause tunnel_lost)', () => {
  const fetchSpec = () =>
    spec({
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: `https://${SHOP}/api/items`, allowed_hosts: [SHOP], params: [{ at: 'url.query.page', role: 'pagination' }] },
      sources: [{ id: 'api', from: 'response', format: 'json', records: '$.items[*]' }],
      fields: { id: { path: '$.id', type: 'string', required: true } },
      pagination: { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'records_empty' }], limits: { max_pages_input: 'input.max_pages', hard_max_pages: 5 } },
    });
  const page = (n: number) => ok({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: n <= 2 ? [{ id: `zz${n}` }] : [] }), url: `https://${SHOP}/api/items?page=${n}` });
  const session = (p: TunnelPort) => new TunnelSession(p, { runId: RUN, ownerId: OWNER, domain: SHOP, allowWriteActions: false, execution: 'fetch' }, new AbortController().signal);
  const run = (s: TunnelSession) => runTunnelExecutor({ session: s, execution: 'fetch', spec: fetchSpec(), input: {}, outputSchema: SCHEMA, signal: new AbortController().signal });

  test('l’extension disparaît après une page lue : arrêt « hors ligne » et tunnel perdu (lost), aucune commande de plus', async () => {
    let calls = 0;
    const p = port(() => {
      calls += 1;
      return calls === 1 ? page(1) : { kind: 'error', error: 'tunnel_offline' };
    });
    const s = session(p);
    const out = await run(s);
    expect(out.stop).toBe('tunnel_offline');
    expect(out.lost).toBe(true);
    expect(s.lost).toBe(true);
    expect(p.sent).toHaveLength(2);
  });

  test('extension jamais connectée pendant ce run : hors ligne, pas « perdu »', async () => {
    const p = port(() => ({ kind: 'error', error: 'tunnel_offline' }));
    const out = await run(session(p));
    expect(out.stop).toBe('tunnel_offline');
    expect(out.lost).toBe(false);
  });

  test('commande émise puis connexion coupée (écriture non rejouable : tunnel_disconnected) : arrêt, tunnel perdu, jamais une erreur réseau ordinaire', async () => {
    const p = port(() => ({ kind: 'error', error: 'tunnel_disconnected' }));
    const s = session(p);
    const out = await run(s);
    expect(out.stop).toBe('tunnel_offline');
    expect(out.lost).toBe(true);
    expect(p.sent).toHaveLength(1);
  });

  test('défi en tunnel : arrêt propre au défi, jamais « perdu »', async () => {
    const p = port(() => ok({ status: 403, headers: { 'content-type': 'application/json' }, body: '{"url":"https://geo.captcha-delivery.com/captcha/?initialCid=zz"}', url: `https://${SHOP}/api/items` }));
    const out = await run(session(p));
    expect(out.stop).toBe('challenge_in_tunnel');
    expect(out.lost).toBe(false);
  });
});
