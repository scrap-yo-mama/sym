// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, test } from 'vitest';
import { runCli } from './cli.js';
import { MasterKey } from './crypto/master-key.js';

describe('CLI du noyau : keygen', () => {
  test('keygen : une MASTER_KEY neuve, seule sur la sortie, acceptée par le chargement', () => {
    const first = runCli(['keygen']);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(() => MasterKey.parse(first.out)).not.toThrow();
    expect(runCli(['keygen']).out).not.toBe(first.out);
  });

  test('commande inconnue ou absente : usage, code 1', () => {
    for (const argv of [[], ['inconnue']]) {
      const res = runCli(argv);
      expect(res.code).toBe(1);
      expect(res.out).toMatch(/keygen/);
    }
    expect(runCli(['--help'])).toMatchObject({ code: 0, out: expect.stringMatching(/keygen/) });
  });
});
