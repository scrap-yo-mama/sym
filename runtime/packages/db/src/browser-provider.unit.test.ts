// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur de navigateur publié par le worker (tâche 4.7) : écriture dans `settings` et relecture validée.
import { describe, expect, it, vi } from 'vitest';
import { publishBrowserProvider, readBrowserProvider } from './browser-provider.js';

const none = { egressPolicy: false, launchArgs: false, freshContextPerRun: false, killBeforeDetach: false, sandboxProbe: false, engineUserAgent: false, privateLatency: false };
const dbReturning = (value: unknown) => ({ query: vi.fn().mockResolvedValue({ rows: value === undefined ? [] : [{ value }] }) }) as never;

describe('browser_provider publié', () => {
  it('écrit le genre, les sept capacités et l’activation, rien d’autre', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await publishBrowserProvider({ query } as never, { kind: 'cdp', capabilities: { ...none, privateLatency: true }, genericCdpEnabled: true });
    const [sql, params] = query.mock.calls[0] as [string, string[]];
    expect(sql).toContain('INSERT INTO settings');
    expect(params[0]).toBe('browser_provider');
    expect(JSON.parse(params[1] as string)).toEqual({ kind: 'cdp', capabilities: { ...none, privateLatency: true }, generic_cdp_enabled: true });
  });

  it('relit ce qui a été publié', async () => {
    const db = dbReturning({ kind: 'sym-browser', capabilities: { ...none, egressPolicy: true }, generic_cdp_enabled: false });
    await expect(readBrowserProvider(db)).resolves.toEqual({ kind: 'sym-browser', capabilities: { ...none, egressPolicy: true }, genericCdpEnabled: false });
  });

  it('aucune publication, genre inconnu ou capacité manquante : null (la console ne devine rien)', async () => {
    await expect(readBrowserProvider(dbReturning(undefined))).resolves.toBeNull();
    await expect(readBrowserProvider(dbReturning({ kind: 'other', capabilities: none }))).resolves.toBeNull();
    await expect(readBrowserProvider(dbReturning({ kind: 'cdp', capabilities: { egressPolicy: false } }))).resolves.toBeNull();
  });
});
