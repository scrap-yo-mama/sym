// SPDX-License-Identifier: AGPL-3.0-only
// Audit de sécurité 5.3 S16 (BINV6, assert_secrets_protected ; docs/audit-securite.md) : secrets de la configuration et
// jetons propres à SYM Browser jamais en clair dans le journal, même cités en toutes lettres par un message ou un champ.
import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createLogger, loadConfig } from '../index.js';

describe('audit 5.3 S16 : assert_secrets_protected, journal masqué', () => {
  test('NODE_TOKEN, SYMB_METRICS_TOKEN, MASTER_KEY et DATABASE_URL : masqués partout dès le chargement de la configuration', () => {
    const secrets = {
      NODE_TOKEN: `zz${randomBytes(18).toString('hex')}`,
      SYMB_METRICS_TOKEN: `zz${randomBytes(18).toString('hex')}`,
      MASTER_KEY: randomBytes(32).toString('base64'),
      DATABASE_URL: `postgres://symb:zzpw${randomBytes(8).toString('hex')}@db:5432/symb`,
    };
    loadConfig({ SYMB_MODE: 'gateway', ...secrets });
    const lines: string[] = [];
    const log = createLogger('info', (line) => lines.push(line));
    for (const value of Object.values(secrets)) log('info', `valeur : ${value}`, { detail: value, nested: { raw: value } });
    const text = lines.join('\n');
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    expect(text).not.toContain(new URL(secrets.DATABASE_URL).password);
  });

  test('secret de webhook whsec_ et jeton de vue en direct v1.<corps>.<mac> : masqués', () => {
    const whsec = `whsec_${randomBytes(24).toString('base64url')}`;
    const live = `v1.${randomBytes(40).toString('base64url')}.${randomBytes(32).toString('base64url')}`;
    const lines: string[] = [];
    createLogger('info', (line) => lines.push(line))('info', `secret ${whsec} et jeton ${live}`, { whsec, live });
    expect(lines.join('\n')).not.toContain(whsec.slice(6));
    expect(lines.join('\n')).not.toContain(live.split('.')[1]);
  });
});
