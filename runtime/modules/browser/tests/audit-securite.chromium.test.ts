// SPDX-License-Identifier: AGPL-3.0-only
// Audit de sécurité 5.3 (docs/audit-securite.md) rejoué de bout en bout sur vrai Chromium 153, au travers des deux relais
// (passerelle → nœud), contre une instance en mode `all` (tests/helpers/all-mode.ts) :
//   S01 / assert_session_isolation (BINV1) : par le protocole Playwright d'une session shared, aucun CDP brut
//     (`newBrowserCDPSession`) ; le refus 409 de `/cdp` sur shared ne se contourne donc pas.
//   S02 : par CDP d'une session dedicated, `DOM.setFileInputFiles` vers un fichier du nœud est refusé.
//   S03 / assert_session_egress_enforced (BINV2) : `file://` refusé par CDP (`Page.navigate`, `Target.createTarget`) et
//     par Playwright (`goto`) ; la fixture http reste joignable.
// Prérequis : Docker, utilisateur non root, `playwright install chromium`. Sécurité : Chromium arrêtés par le pool.
import { chromium } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { startAllMode, type AllModeInstance } from './helpers/all-mode.ts';

let instance: AllModeInstance;

beforeAll(async () => {
  instance = await startAllMode();
}, 240_000);

afterAll(async () => {
  await instance?.close();
}, 120_000);

type Created = { id: string; connectUrls: { cdp: string | null; playwright: string } };

async function create(type: 'shared' | 'dedicated'): Promise<Created> {
  const res = await fetch(`${instance.url}/v1/sessions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${instance.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ type }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as Created;
}

async function release(id: string): Promise<void> {
  await fetch(`${instance.url}/v1/sessions/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${instance.apiKey}` } });
}

describe('audit 5.3 sur vrai Chromium', () => {
  test('S02 et S03 (assert_session_egress_enforced) : session dedicated par CDP, file:// et fichiers du nœud refusés, fixture lue', async () => {
    const session = await create('dedicated');
    const browser = await chromium.connectOverCDP(session.connectUrls.cdp!);
    try {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      await expect(page.goto('file:///etc/hostname')).rejects.toThrow(/schéma de navigation refusé/);
      const root = await browser.newBrowserCDPSession();
      await expect(root.send('Target.createTarget', { url: 'file:///etc/hostname' })).rejects.toThrow(/schéma de navigation refusé/);
      await page.goto(instance.siteUrl);
      expect(await page.title()).not.toBe('');
      await page.setContent('<input type="file" id="f">');
      const cdp = await context.newCDPSession(page);
      const { root: doc } = (await cdp.send('DOM.getDocument')) as { root: { nodeId: number } };
      const { nodeId } = (await cdp.send('DOM.querySelector', { nodeId: doc.nodeId, selector: '#f' })) as { nodeId: number };
      await expect(cdp.send('DOM.setFileInputFiles', { nodeId, files: ['/etc/hostname'] })).rejects.toThrow(/hors des envois/);
      expect(await page.$eval('#f', (input) => (input as unknown as { files: { length: number } | null }).files?.length ?? 0)).toBe(0);
    } finally {
      await browser.close().catch(() => undefined);
      await release(session.id);
    }
  });

  test('S01 (assert_session_isolation) : session shared par Playwright, pas de CDP brut ni de file://', async () => {
    const session = await create('shared');
    expect(session.connectUrls.cdp).toBeNull();
    const browser = await chromium.connect(session.connectUrls.playwright);
    try {
      await expect(browser.newBrowserCDPSession()).rejects.toThrow(/refusé par SYM Browser/);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = await context.newPage();
      await expect(context.newCDPSession(page)).rejects.toThrow(/refusé par SYM Browser/);
      await expect(page.goto('file:///etc/hostname')).rejects.toThrow(/schéma de navigation refusé/);
      await page.goto(instance.siteUrl);
      expect(await page.title()).not.toBe('');
    } finally {
      await browser.close().catch(() => undefined);
      await release(session.id);
    }
  });
});
