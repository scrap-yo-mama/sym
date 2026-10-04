// SPDX-License-Identifier: AGPL-3.0-only
// `BrowserEgress.server` peut être `null` (fournisseur distant : le nœud impose son egress, tâche 4.1 ; 04e §2.2) : le
// contexte de run n'a alors aucun `proxy` ; avec un serveur local, le proxy de l'essai reste posé.
import type { Browser } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { openRunContext, runContextGuards, runContextProxy } from './run-context.js';

describe('proxy du contexte de run', () => {
  it('serveur local : proxy de l’essai', () => {
    expect(runContextProxy('http://127.0.0.1:4567')).toEqual({ proxy: { server: 'http://127.0.0.1:4567' } });
  });
  it('null : aucune option proxy', () => {
    expect(runContextProxy(null)).toEqual({});
  });
});

describe('egress distant : attach (tâche 4.3)', () => {
  it('serveur null : la politique de l’essai est posée sur la session AVANT tout contexte ; un refus du nœud arrête l’ouverture', async () => {
    const browser = {} as Browser;
    const attach = vi.fn().mockRejectedValue(new Error('zz_attach_refused'));
    await expect(openRunContext(browser, { egressServer: null, egress: { attach }, allowedHosts: ['a.example'] })).rejects.toThrow('zz_attach_refused');
    expect(attach).toHaveBeenCalledWith(browser);
  });

  it('serveur local : attach jamais appelé (le proxy local porte la politique)', async () => {
    const attach = vi.fn().mockResolvedValue(undefined);
    await openRunContext({} as Browser, { egressServer: 'http://127.0.0.1:1', egress: { attach }, allowedHosts: [] }).catch(() => undefined);
    expect(attach).not.toHaveBeenCalled();
  });
});

describe('gardes du worker selon les capacités du fournisseur (tâche 4.7, 4.6)', () => {
  const none = { egressPolicy: false, launchArgs: false, freshContextPerRun: false, killBeforeDetach: false, sandboxProbe: false, engineUserAgent: false, privateLatency: false };
  it('sans capacités déclarées (local, sym-browser) : egress qui impose les domaines, lancement qui coupe WebSocketStream', () => {
    expect(runContextGuards({})).toEqual({ egressEnforcesDomains: true, neutralizeLaunchFeatures: false });
  });
  it('cdp : le worker coupe lui-même les sauts hors domaines et neutralise WebSocketStream par script d’init', () => {
    expect(runContextGuards({ egress: { capabilities: none } })).toEqual({ egressEnforcesDomains: false, neutralizeLaunchFeatures: true });
  });
  it('une option explicite l’emporte', () => {
    expect(runContextGuards({ egressEnforcesDomains: true, neutralizeLaunchFeatures: false, egress: { capabilities: none } })).toEqual({ egressEnforcesDomains: true, neutralizeLaunchFeatures: false });
  });
});
