// SPDX-License-Identifier: AGPL-3.0-only
// UX-04 : la cause stable d'un run en échec est publiée avec son message, sa marche à suivre et `retryable`.
import { describe, expect, test } from 'vitest';
import { runErrorFor, runErrorOf } from './run-error.js';

describe('cause d’un run en échec (UX-04)', () => {
  test('instance_contact_missing : code stable, message lisible, what_to_do, retryable', () => {
    const error = runErrorOf({ state: 'failed', error_detail: 'instance_contact_missing' });
    expect(error).toEqual({
      code: 'instance_contact_missing',
      message: 'Renseigne le contact du robot dans Réglages > Identité du robot, ou la variable INSTANCE_CONTACT.',
      what_to_do: expect.stringContaining('/settings/robot'),
      retryable: true,
    });
    expect(runErrorFor('instance_contact_missing')).toEqual(error);
  });

  test('un run qui n’a pas échoué, ou un détail non nommé, ne publie aucune cause', () => {
    expect(runErrorOf({ state: 'succeeded', error_detail: 'instance_contact_missing' })).toBeNull();
    expect(runErrorOf({ state: 'failed', error_detail: 'https://zz-test.example/secret' })).toBeNull();
    expect(runErrorOf({ state: 'failed', error_detail: null })).toBeNull();
  });
});
