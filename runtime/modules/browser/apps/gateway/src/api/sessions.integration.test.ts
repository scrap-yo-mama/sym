// SPDX-License-Identifier: AGPL-3.0-only
// API REST des sessions (cdc/sym-browser 04 § 1 à § 9, 04f § 2, tâche 2.2) sur PostgreSQL réel. Chaque réponse est
// validée contre l'OpenAPI publiée par le banc (statut déclaré, corps conforme) : 0 écart schéma/réponse.
// Tests nommés : session_default_dedicated (F1, F9), session_id_reserved (A2), invalid_option_typed (A3),
// idempotent_create (A9), cursor_pagination (A10), release_idempotent (A12).
import { BROWSER_ENGINE, BROWSER_PROTOCOL_VERSION, browserOpenApi } from '@sym/contracts/browser';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHarness, type Harness } from '../../test/helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ maxSessionSeconds: 600 });
});
afterAll(async () => {
  await h.close();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const create = (body: unknown = {}, extra: { key?: 'a' | 'aRead' | 'b'; headers?: Record<string, string>; query?: string } = {}) =>
  h.call({ method: 'POST', url: `/v1/sessions${extra.query ?? ''}`, body, key: extra.key ?? 'a', headers: extra.headers ?? {} });

describe('session_default_dedicated (F1, F9)', () => {
  test('F1 : sans type, session dedicated running, connectUrls à trois clés (cdp wss à jeton, playwright, bidi nul)', async () => {
    const res = await create({});
    expect(res.status).toBe(201);
    const session = res.body;
    expect(session).toMatchObject({ state: 'running', type: 'dedicated', nodeRegion: 'frankfurt' });
    expect(session.id).toMatch(UUID);
    expect(Object.keys(session.connectUrls).sort()).toEqual(['bidi', 'cdp', 'playwright']);
    expect(session.connectUrls.cdp).toMatch(new RegExp(`^wss://b\\.example\\.com/v1/sessions/${session.id}/cdp\\?token=symt_[A-Za-z0-9_-]+$`));
    expect(session.connectUrls.playwright).toMatch(new RegExp(`^wss://b\\.example\\.com/v1/sessions/${session.id}/playwright\\?token=symt_[A-Za-z0-9_-]+$`));
    expect(session.connectUrls.bidi).toBeNull();
    expect(res.headers['x-request-id']).toMatch(/^req_/);
  });

  test('shared demandé : cdp nul (Playwright natif seulement) ; profil ou launchArgs : bascule en dedicated', async () => {
    const shared = await create({ type: 'shared' });
    expect(shared.status).toBe(201);
    expect(shared.body.type).toBe('shared');
    expect(shared.body.connectUrls.cdp).toBeNull();
    expect(shared.body.connectUrls.playwright).toMatch(/^wss:\/\/.*\/playwright\?token=/);
    const switched = await create({ type: 'shared', launchArgs: ['mute-audio'] });
    expect(switched.body.type).toBe('dedicated');
    expect(switched.body.connectUrls.cdp).toMatch(/\/cdp\?token=/);
  });

  test('F9 : GET /v1/version sans authentification, product sym-browser et contract = version du contrat publié', async () => {
    const res = await h.call({ method: 'GET', url: '/v1/version', key: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      product: 'sym-browser',
      api: '1',
      contract: BROWSER_PROTOCOL_VERSION,
      playwright: BROWSER_ENGINE.playwright,
      chromium: BROWSER_ENGINE.chromium,
      platform: 'linux',
      minSdk: '1.0.0',
    });
  });

  test('OpenAPI 3.1 publiée sur /v1/openapi.json, identique au contrat', async () => {
    const res = await h.call({ method: 'GET', url: '/v1/openapi.json', key: null });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(JSON.parse(JSON.stringify(browserOpenApi)));
  });
});

describe('création', () => {
  test('wait=false : 202 pending sans connectUrls, puis running à la relecture', async () => {
    const res = await create({}, { query: '?wait=false' });
    expect(res.status).toBe(202);
    expect(res.body.state).toBe('pending');
    expect(res.body.connectUrls).toBeUndefined();
    let state = 'pending';
    for (let i = 0; i < 50 && state === 'pending'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      state = (await h.call({ method: 'GET', url: `/v1/sessions/${res.body.id}` })).body.state;
    }
    expect(state).toBe('running');
  });

  test('durée plafonnée par la durée max du client ; défaut 300 s ; metadata relue', async () => {
    const res = await create({ timeoutSeconds: 10_000, metadata: { job: 'j1' } });
    const span = Date.parse(res.body.expiresAt) - Date.parse(res.body.createdAt);
    expect(span).toBeGreaterThan(599_000);
    expect(span).toBeLessThanOrEqual(600_000);
    expect(res.body.metadata).toEqual({ job: 'j1' });
    const byDefault = await create({});
    expect(Date.parse(byDefault.body.expiresAt) - Date.parse(byDefault.body.createdAt)).toBeLessThanOrEqual(300_000);
  });

  test('lancement impossible : 503 no_node avec Retry-After, session failed raison crash', async () => {
    h.launcher.mode = 'fail';
    try {
      const res = await create({ metadata: { cas: 'echec' } });
      expect(res.status).toBe(503);
      expect(res.body.error).toMatchObject({ code: 'no_node', retryable: true });
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
      const { rows } = await h.pool.query("SELECT state, end_reason FROM sessions WHERE metadata->>'cas' = 'echec'");
      expect(rows).toEqual([{ state: 'failed', end_reason: 'crash' }]);
    } finally {
      h.launcher.mode = 'ok';
    }
  });

  test('délai de file dépassé (QUEUE_TIMEOUT_MS) : 429 capacity_exceeded avec Retry-After, session failed raison quota', async () => {
    h.launcher.mode = 'hang';
    try {
      const res = await create({ metadata: { cas: 'file' } });
      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('capacity_exceeded');
      expect(res.headers['retry-after']).toMatch(/^\d+$/);
      const { rows } = await h.pool.query("SELECT state, end_reason FROM sessions WHERE metadata->>'cas' = 'file'");
      expect(rows).toEqual([{ state: 'failed', end_reason: 'quota' }]);
    } finally {
      h.launcher.mode = 'ok';
    }
  });

  test('région sans nœud ready : 503 no_node, aucune session créée', async () => {
    const res = await create({ region: 'tokyo', metadata: { cas: 'region' } });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('no_node');
    expect((await h.pool.query("SELECT 1 FROM sessions WHERE metadata->>'cas' = 'region'")).rowCount).toBe(0);
  });
});

describe('session_id_reserved (A2)', () => {
  test('id réservé par l’appelant ; doublon (même client ou autre client) : 409 session_id_taken', async () => {
    const id = '0d3f2c1a-6b7e-4a5f-9c8d-1e2f3a4b5c6d';
    const first = await create({ id });
    expect(first.status).toBe(201);
    expect(first.body.id).toBe(id);
    const again = await create({ id });
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'session_id_taken', retryable: false });
    const otherTenant = await create({ id }, { key: 'b' });
    expect(otherTenant.status).toBe(409);
    expect(otherTenant.body.error.code).toBe('session_id_taken');
  });
});

describe('invalid_option_typed (A3)', () => {
  test.each([
    [{ launchArgs: ['--no-sandbox'] }, 'launchArgs[0]'],
    [{ unknownField: true }, 'unknownField'],
    [{ timeoutSeconds: 0 }, 'timeoutSeconds'],
    [{ type: 'remote' }, 'type'],
    [{ viewport: { width: 1280 } }, 'viewport.height'],
    [{ extraHTTPHeaders: { Host: 'evil.example' } }, 'extraHTTPHeaders'],
    [{ id: 'pas-un-uuid' }, 'id'],
    [{ metadata: { k: 'x'.repeat(513) } }, 'metadata.k'],
    // Trouvés par Schemathesis : PostgreSQL ne garde ni U+0000 ni une moitié de paire de substitution en jsonb.
    [{ metadata: { k: 'a\u0000b' } }, 'metadata.k'],
    [{ storageState: { cookies: [{ name: '\ud800' }], origins: [] } }, 'storageState.cookies[0].name'],
  ])('%j → 422 invalid_option nommant %s', async (body, field) => {
    const res = await create(body);
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'invalid_option', retryable: false });
    expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
  });

  test('corps JSON illisible ou non objet : 422 invalid_option ; paramètre de requête invalide : 422', async () => {
    const broken = await h.call({ method: 'POST', url: '/v1/sessions', body: '{"type":', headers: { 'content-type': 'application/json' } });
    expect(broken.status).toBe(422);
    expect(broken.body.error.code).toBe('invalid_option');
    expect((await create([1, 2])).status).toBe(422);
    expect((await create({}, { query: '?wait=peut-etre' })).status).toBe(422);
  });
});

describe('idempotent_create (A9)', () => {
  test('même Idempotency-Key, même corps : une session, réponse d’origine rejouée ; corps différent : 409', async () => {
    const headers = { 'idempotency-key': 'cle-idempotence-0001' };
    const first = await create({ metadata: { idem: '1' } }, { headers });
    expect(first.status).toBe(201);
    const replay = await create({ metadata: { idem: '1' } }, { headers });
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect((await h.pool.query("SELECT 1 FROM sessions WHERE metadata->>'idem' = '1'")).rowCount).toBe(1);

    const conflict = await create({ metadata: { idem: '2' } }, { headers });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('idempotency_conflict');
    // La clé est propre au client : le client B peut réutiliser la même valeur.
    expect((await create({}, { key: 'b', headers })).status).toBe(201);
  });

  test('clé hors bornes (8 à 128 caractères) : 422', async () => {
    expect((await create({}, { headers: { 'idempotency-key': 'court' } })).status).toBe(422);
  });

  test('prolongation idempotente : le temps n’est ajouté qu’une fois', async () => {
    const session = (await create({ timeoutSeconds: 60 })).body;
    const headers = { 'idempotency-key': 'prolongation-0001' };
    const once = await h.call({ method: 'POST', url: `/v1/sessions/${session.id}/extend`, body: { timeoutSeconds: 30 }, headers });
    const twice = await h.call({ method: 'POST', url: `/v1/sessions/${session.id}/extend`, body: { timeoutSeconds: 30 }, headers });
    expect(twice.headers['idempotent-replayed']).toBe('true');
    expect(twice.body.expiresAt).toBe(once.body.expiresAt);
    expect(Date.parse(once.body.expiresAt) - Date.parse(session.expiresAt)).toBe(30_000);
  });
});

describe('lecture et liste', () => {
  test('GET : jetons renouvelés à chaque lecture d’une session running ; session d’un autre client : 404', async () => {
    const session = (await create({})).body;
    const read1 = await h.call({ method: 'GET', url: `/v1/sessions/${session.id}` });
    const read2 = await h.call({ method: 'GET', url: `/v1/sessions/${session.id}` });
    expect(read1.status).toBe(200);
    expect(read2.body.connectUrls.cdp).not.toBe(read1.body.connectUrls.cdp);
    const foreign = await h.call({ method: 'GET', url: `/v1/sessions/${session.id}`, key: 'b' });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe('session_not_found');
    expect((await h.call({ method: 'GET', url: '/v1/sessions/pas-un-uuid' })).status).toBe(404);
  });

  test('cursor_pagination (A10) : 120 sessions par pages de 50, chacune une fois, nextCursor nul à la fin, stable malgré les créations', async () => {
    const tag = { lot: 'pagination' };
    const created = new Set<string>();
    for (let i = 0; i < 120; i += 1) created.add((await create({ metadata: tag }, { query: '?wait=false' })).body.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/v1/sessions?limit=50&metadata.lot=pagination${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await h.call({ method: 'GET', url });
      expect(page.status).toBe(200);
      pages += 1;
      for (const s of page.body.data) seen.push(s.id);
      // Créations concurrentes pendant la pagination : plus récentes, elles ne décalent pas les pages suivantes.
      if (pages === 1) for (let i = 0; i < 3; i += 1) await create({ metadata: tag }, { query: '?wait=false' });
      cursor = page.body.nextCursor;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((id) => created.has(id))).toHaveLength(120);
    // Tri par createdAt décroissant.
    const page = await h.call({ method: 'GET', url: '/v1/sessions?limit=200&metadata.lot=pagination' });
    const dates = page.body.data.map((s: { createdAt: string }) => Date.parse(s.createdAt));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
  });

  test('filtres (état, type, période) et isolation par client ; limite et curseur invalides : 422', async () => {
    await create({ type: 'shared', metadata: { lot: 'filtres' } });
    const sharedOnly = await h.call({ method: 'GET', url: '/v1/sessions?type=shared&state=running&metadata.lot=filtres' });
    expect(sharedOnly.body.data.length).toBeGreaterThan(0);
    expect(sharedOnly.body.data.every((s: { type: string; state: string }) => s.type === 'shared' && s.state === 'running')).toBe(true);
    const future = await h.call({ method: 'GET', url: `/v1/sessions?createdAfter=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}` });
    expect(future.body).toEqual({ data: [], nextCursor: null });
    const b = await h.call({ method: 'GET', url: '/v1/sessions?metadata.lot=filtres', key: 'b' });
    expect(b.body.data).toEqual([]);
    for (const query of ['limit=0', 'limit=201', 'cursor=n%27importe-quoi', 'state=paused', 'createdAfter=hier']) {
      const res = await h.call({ method: 'GET', url: `/v1/sessions?${query}` });
      expect(res.status, query).toBe(422);
      expect(res.body.error.code).toBe('invalid_option');
    }
  });
});

describe('release_idempotent (A12) et prolongation', () => {
  test('DELETE d’une session running : ended released ; rejoué : 200 sans effet, même réponse', async () => {
    const session = (await create({})).body;
    const released = await h.call({ method: 'DELETE', url: `/v1/sessions/${session.id}` });
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ state: 'ended', endReason: 'released' });
    expect(released.body.connectUrls).toBeUndefined();
    const replay = await h.call({ method: 'DELETE', url: `/v1/sessions/${session.id}` });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(released.body);
    expect(h.launcher.released.filter((id) => id === session.id)).toHaveLength(1);
  });

  test('DELETE d’une session pending (wait=false, pas encore démarrée) : ended released sans nœud', async () => {
    h.launcher.mode = 'hang';
    try {
      const pending = (await create({}, { query: '?wait=false' })).body;
      const released = await h.call({ method: 'DELETE', url: `/v1/sessions/${pending.id}` });
      expect(released.status).toBe(200);
      expect(released.body).toMatchObject({ state: 'ended', endReason: 'released' });
    } finally {
      h.launcher.mode = 'ok';
    }
  });

  test('DELETE : session inconnue ou d’un autre client : 404 ; clé sans sessions:write : 403', async () => {
    const session = (await create({})).body;
    expect((await h.call({ method: 'DELETE', url: `/v1/sessions/${session.id}`, key: 'b' })).status).toBe(404);
    const forbidden = await h.call({ method: 'DELETE', url: `/v1/sessions/${session.id}`, key: 'aRead' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('forbidden');
  });

  test('extend : ajoute du temps plafonné par la durée max du client ; session terminée : 422 ; inconnue : 404', async () => {
    const session = (await create({ timeoutSeconds: 300 })).body;
    const plus = await h.call({ method: 'POST', url: `/v1/sessions/${session.id}/extend`, body: { timeoutSeconds: 120 } });
    expect(plus.status).toBe(200);
    expect(Date.parse(plus.body.expiresAt) - Date.parse(session.expiresAt)).toBe(120_000);
    const capped = await h.call({ method: 'POST', url: `/v1/sessions/${session.id}/extend`, body: { timeoutSeconds: 100_000 } });
    expect(Date.parse(capped.body.expiresAt) - Date.parse(session.createdAt)).toBe(600_000);
    await h.call({ method: 'DELETE', url: `/v1/sessions/${session.id}` });
    const ended = await h.call({ method: 'POST', url: `/v1/sessions/${session.id}/extend`, body: { timeoutSeconds: 60 } });
    expect(ended.status).toBe(422);
    expect(ended.body.error.details).toEqual([{ field: 'id', reason: 'session_finished' }]);
    expect((await h.call({ method: 'POST', url: '/v1/sessions/00000000-0000-4000-8000-000000000000/extend', body: { timeoutSeconds: 60 } })).status).toBe(404);
    expect((await h.call({ method: 'POST', url: `/v1/sessions/${session.id}/extend`, body: { timeoutSeconds: 0 } })).status).toBe(422);
  });
});

describe('authentification et erreurs typées (04 § 1 et § 6)', () => {
  test('sans clé ou clé inconnue : 401 unauthorized ; X-Request-Id sur chaque réponse', async () => {
    const none = await h.call({ method: 'GET', url: '/v1/sessions', key: null });
    expect(none.status).toBe(401);
    expect(none.body.error).toMatchObject({ code: 'unauthorized', retryable: false });
    expect(none.body.error.requestId).toBe(none.headers['x-request-id']);
    const unknown = await h.call({ method: 'GET', url: '/v1/sessions', key: null, headers: { authorization: 'Bearer symb_inconnue' } });
    expect(unknown.status).toBe(401);
  });

  test('what_to_do dans la langue demandée (Accept-Language), en par défaut', async () => {
    const fr = await h.call({ method: 'GET', url: '/v1/sessions', key: null, headers: { 'accept-language': 'fr-FR,fr;q=0.9' } });
    const en = await h.call({ method: 'GET', url: '/v1/sessions', key: null });
    expect(fr.body.error.what_to_do).toMatch(/clé d’API/);
    expect(en.body.error.what_to_do).toMatch(/API key/);
  });

  test('clé lecture seule : création refusée 403 forbidden', async () => {
    const res = await create({}, { key: 'aRead' });
    expect(res.status).toBe(403);
    expect(res.body.error.details).toEqual({ requiredScope: 'sessions:write' });
  });
});
