// SPDX-License-Identifier: AGPL-3.0-only
// Garde d'écriture du tunnel (07 § 5, 08 § 4) contre un VRAI Chromium : le pilote CDP de l'extension
// (`activationIsWrite`, `clickIsWrite`) lit la chaîne d'ancêtres par `Accessibility.getPartialAXTree` puis
// `DOM.describeNode`, comme dans l'extension. Prouve sur l'arbre réel ce que les tests unitaires simulent : un `<form>`
// sans nom reste dans la chaîne (nœud ignoré gardé), un `<button>` sans type hors formulaire est une lecture (« Voir
// plus » d'une SPA), et `aria-owns`, qui fait disparaître le `<form>` de la chaîne, reste fermé.
import { chromium, type Browser, type CDPSession, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { activationIsWrite, clickIsWrite, type CdpSend } from '../../apps/extension/src/core/cdp-driver.ts';

const HTML = `<!doctype html><html><head><title>zz-test SPA</title></head><body><main>
  <form action="/save"><div><div class="row"><button id="in"><span id="in-span">OK</span></button></div></div>
    <button id="plain" type="button">Trier</button></form>
  <div class="list"><div><button id="more"><span id="more-span">Voir plus</span></button></div></div>
  <button id="ext" form="pay">Go</button><form id="pay"></form>
  <form><div><button id="owned">Owned</button></div></form><div id="owner" aria-owns="owned"></div>
  <a id="next" href="#page-2">Page 2</a>
</main></body></html>`;

let browser: Browser;
let page: Page;
let cdp: CDPSession;
let send: CdpSend;

const backendOf = async (selector: string): Promise<number> => {
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
  const { node } = await cdp.send('DOM.describeNode', { nodeId });
  return node.backendNodeId;
};

const centre = async (selector: string): Promise<{ x: number; y: number }> => {
  const box = (await page.locator(selector).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

beforeAll(async () => {
  // Aucun réseau : page posée par setContent, proxy injoignable pour tout le reste.
  browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: ['--proxy-server=127.0.0.1:9', '--proxy-bypass-list=<-loopback>'] });
  page = await browser.newPage();
  await page.setContent(HTML);
  cdp = await page.context().newCDPSession(page);
  send = (method, params) => cdp.send(method as 'DOM.describeNode', params as never) as Promise<unknown>;
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

describe('garde d’écriture du tunnel dans Chromium', () => {
  test('assert_write_action_blocked (Chromium) : bouton sans type dans un formulaire (même imbriqué), form=, aria-owns → écriture ; « Voir plus » hors formulaire, type=button, lien → lecture', async () => {
    const verdicts: Record<string, boolean> = {};
    for (const id of ['in', 'in-span', 'plain', 'more', 'more-span', 'ext', 'owned', 'next']) {
      verdicts[id] = await activationIsWrite(send, { backendNodeId: await backendOf(`#${id}`) });
    }
    expect(verdicts).toEqual({ in: true, 'in-span': true, plain: false, more: false, 'more-span': false, ext: true, owned: true, next: false });
    // Au point du clic (nœud réellement touché) : même verdict.
    for (const [id, write] of [['in-span', true], ['more-span', false], ['owned', true], ['next', false]] as const) {
      const { x, y } = await centre(`#${id}`);
      expect(await clickIsWrite(send, x, y), id).toBe(write);
    }
  });
});
