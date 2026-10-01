// SPDX-License-Identifier: AGPL-3.0-only
// Appel d'API sans exception : le serveur renvoie des codes stables, la console choisit le message traduit.
import { describe, expect, test } from 'vitest';
import { call, errorCodeOf } from './api-call';

const response = (status: number) => new Response(null, { status });

describe('call', () => {
  test('succès : données et statut', async () => {
    expect(await call(async () => ({ data: { a: 1 }, response: response(201) }))).toEqual({ ok: true, data: { a: 1 }, status: 201 });
  });

  test('erreur : code stable du serveur, sinon message du statut', async () => {
    expect(await call(async () => ({ error: { error: { code: 'queue_full', message: 'x' } }, response: response(429) }))).toMatchObject({ ok: false, code: 'queue_full', messageKey: 'errors.queue_full' });
    expect(await call(async () => ({ error: { error: { code: 'inconnu', message: 'x' } }, response: response(403) }))).toMatchObject({ messageKey: 'errors.forbidden' });
    expect(await call(async () => ({ error: undefined, response: response(404) }))).toMatchObject({ messageKey: 'errors.not_found' });
    expect(await call(async () => ({ error: undefined, response: response(503) }))).toMatchObject({ messageKey: 'errors.server' });
    expect(await call(async () => ({ error: undefined, response: response(418) }))).toMatchObject({ messageKey: 'errors.generic' });
  });

  test('coupure réseau : jamais d’exception', async () => {
    expect(
      await call(async () => {
        throw new TypeError('fetch failed');
      }),
    ).toEqual({ ok: false, status: 0, code: null, messageKey: 'errors.network' });
  });

  test('errorCodeOf lit seulement { error: { code } }', () => {
    expect(errorCodeOf({ error: { code: 'x' } })).toBe('x');
    expect(errorCodeOf({ code: 'x' })).toBeNull();
    expect(errorCodeOf(null)).toBeNull();
  });
});
