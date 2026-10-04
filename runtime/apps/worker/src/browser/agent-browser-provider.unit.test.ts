// SPDX-License-Identifier: AGPL-3.0-only
// `launchAgentBrowser` passe par `BrowserProvider.launchDedicated` (tâche 4.1 ; 04e §2.2) : plus de `spawn` ni de
// `connectOverCDP` dans ce fichier ; les options de l'essai (User-Agent, egress, domaines) vont au fournisseur.
import { describe, expect, it, vi } from 'vitest';
import { launchAgentBrowser } from './agent-browser.js';
import type { BrowserProvider } from '@sym/contracts/browser';

describe('launchAgentBrowser : délégation au fournisseur', () => {
  it('appelle provider.launchDedicated avec User-Agent, egress et délai ; l’échec du fournisseur remonte tel quel', async () => {
    const failure = new Error('zz_test_launch_failed');
    const launchDedicated = vi.fn().mockRejectedValue(failure);
    const provider = { kind: 'local', launchDedicated } as unknown as BrowserProvider;
    const error = await launchAgentBrowser({
      egressServer: 'http://127.0.0.1:9',
      allowedHosts: ['zz-test.example'],
      allowWriteActions: false,
      userAgent: 'zz-robot/1.0',
      launchTimeoutMs: 1234,
      provider,
    }).catch((e: unknown) => e);
    expect(error).toBe(failure);
    expect(launchDedicated).toHaveBeenCalledTimes(1);
    expect(launchDedicated.mock.calls[0]![0]).toMatchObject({
      userAgent: 'zz-robot/1.0',
      egressServer: 'http://127.0.0.1:9',
      egress: { allowedHosts: ['zz-test.example'] },
      launchArgs: [],
      launchTimeoutMs: 1234,
    });
  });
});
