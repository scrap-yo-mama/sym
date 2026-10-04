// SPDX-License-Identifier: AGPL-3.0-only
// Fournisseur de navigateur `local` (tâche 4.1 ; cdc/sym-browser 04e §2) : le code actuel du worker (Chromium partagé du pool,
// Chromium dédié de l'essai agentique, identité du moteur, egress de l'essai) derrière `BrowserProvider`, sans changement de
// comportement.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowserEgress } from '@runtime/core/net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installedEngineIdentity } from './engine-identity.js';
import { ChromiumLaunchError, createLocalProvider } from './provider-local.js';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'zz_test_provider_local_'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('fournisseur local', () => {
  const provider = createLocalProvider({ launchProxyUrl: 'http://127.0.0.1:9', env: { PATH: process.env['PATH'] ?? '' } });

  it('kind local, capacités toutes présentes (le Chromium du worker les tient toutes)', () => {
    expect(provider.kind).toBe('local');
    expect(provider.capabilities).toEqual({
      egressPolicy: true,
      launchArgs: true,
      freshContextPerRun: true,
      killBeforeDetach: true,
      sandboxProbe: true,
      engineUserAgent: true,
      privateLatency: true,
    });
  });

  it('identité du moteur : celle du Chromium installé', async () => {
    await expect(provider.engineIdentity()).resolves.toEqual(installedEngineIdentity());
  });

  it("egress de l'essai : le proxy local actuel (openBrowserEgress)", () => {
    expect(provider.openEgress).toBe(openBrowserEgress);
  });

  it('launchDedicated : binaire absent, code fermé chromium_not_started:ENOENT (code de lancement déplacé tel quel)', async () => {
    const local = createLocalProvider({ launchProxyUrl: 'http://127.0.0.1:9', env: { PATH: process.env['PATH'] ?? '' }, executablePath: join(dir, 'absent') });
    const error = await local
      .launchDedicated({ userAgent: 'zz-robot/1.0', egress: {}, egressServer: 'http://127.0.0.1:9', launchArgs: [], launchTimeoutMs: 20_000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChromiumLaunchError);
    expect((error as Error).message).toBe('chromium_not_started:ENOENT');
  });

  it('launchDedicated sans proxy local (egressServer null) : refusé, le Chromium local passe toujours par le proxy de l’essai', async () => {
    const path = join(dir, 'never.js');
    await writeFile(path, '#!/usr/bin/env node\nprocess.exit(0)\n');
    await chmod(path, 0o755);
    const local = createLocalProvider({ launchProxyUrl: 'http://127.0.0.1:9', env: {}, executablePath: path });
    await expect(local.launchDedicated({ userAgent: 'zz-robot/1.0', egress: {}, egressServer: null, launchArgs: [] })).rejects.toThrow(/egressServer/);
  });
});
