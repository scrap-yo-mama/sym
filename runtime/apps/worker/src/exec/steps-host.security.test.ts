// SPDX-License-Identifier: AGPL-3.0-only
// Observation des stratégies `steps` (tâche 2.13, revue) sur une page HOSTILE, étage S (Chromium réel) : la vue de la
// page (début et fin de CHAQUE étape, observation de l'agent d'étape) est bornée DANS la page, sur le modèle de
// browser/bounded.ts (1.6) : une page qui surcharge `String.prototype.slice`, `replace`, `trim`, `Array.prototype.push`
// ou le getter `innerText` peut fausser ce qu'elle montre (c'est son contenu), jamais la borne ; rien de gros ne passe
// le transfert CDP vers le processus Node du worker (disponibilité des runs des autres membres).
import { validateStepsSpec } from '@runtime/core';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { SandboxBridgeError } from '../sandbox/bridges.js';
import { StepsHost, type StepPageTools } from './steps-host.js';

/** 2 millions de caractères par valeur : bien au-delà de toute borne de la vue (300 par nom, 20 000 de texte). */
const HUGE = 2_000_000;
const HOSTILE = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Catalogue</title><script>
  const big = 'x'.repeat(${HUGE});
  String.prototype.slice = function () { return big; };
  String.prototype.replace = function () { return big; };
  String.prototype.trim = function () { return big; };
  String.prototype.split = function () { return [big, big]; };
  String.prototype.toLowerCase = function () { return big; };
  Array.prototype.push = function (v) { for (let i = 0; i < 3; i++) this[this.length] = v; return this.length; };
  Object.defineProperty(HTMLElement.prototype, 'innerText', { get() { return big; }, configurable: true });
</script></head><body><h1>Catalogue</h1><nav><a href="/p2">Page suivante</a><a href="/p3" aria-label="Autre">x</a></nav><p>Titre : Vélo rouge</p></body></html>`;

let browser: Browser;
let page: Page;
/** Taille (caractères JSON) de chaque valeur rendue par la page au processus Node (transfert CDP). */
const transfers: number[] = [];

const spec = (() => {
  const checked = validateStepsSpec({
    schema_version: 1,
    kind: 'steps',
    start_url: 'http://zz_test_hostile.localhost/',
    allowed_hosts: ['zz_test_hostile.localhost'],
    steps: [{ id: 's1', op: 'extract', fields: { titre: { label: 'Titre', ops: [] } } }],
  });
  if (!checked.ok) throw new Error(checked.errors.join(';'));
  return checked.spec;
})();

const tools = (): StepPageTools => ({
  page,
  timeoutMs: 2_000,
  goto: async () => undefined,
  click: async () => undefined,
});

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.setContent(HOSTILE);
  // Mesure du transfert : chaque valeur rendue par `page.evaluate` est pesée côté Node, avant tout usage.
  const evaluate = page.evaluate.bind(page) as (...args: unknown[]) => Promise<unknown>;
  (page as unknown as { evaluate: (...args: unknown[]) => Promise<unknown> }).evaluate = async (...args: unknown[]) => {
    const value = await evaluate(...args);
    transfers.push(JSON.stringify(value ?? null).length);
    return value;
  };
}, 120_000);

afterAll(async () => {
  await browser?.close();
});

describe('vue bornée dans la page (page hostile : slice, replace, trim, push et innerText surchargés)', () => {
  test('observation de l’agent d’étape : noms ≤ 300, éléments ≤ 300, texte ≤ 20 000, aucun gros transfert', async () => {
    transfers.length = 0;
    const host = new StepsHost({ spec, source: [{ id: 's1', intent: 'Lire', pre: {}, post: [], derived_from_untrusted: true }], runInput: {} });
    const obs = await host.agentPage(tools(), {}).observe();
    expect(obs.elements.length).toBeLessThanOrEqual(300);
    for (const e of obs.elements) {
      expect(e.name.length).toBeLessThanOrEqual(300);
      expect(e.role.length).toBeLessThanOrEqual(40);
    }
    expect(obs.text.length).toBeLessThanOrEqual(20_000);
    expect(Math.max(0, ...transfers)).toBeLessThan(200_000);
  }, 60_000);

  test('début et fin d’étape : la borne tient, l’extraction échoue proprement (response_too_large), sans gros transfert', async () => {
    transfers.length = 0;
    const host = new StepsHost({ spec, source: [{ id: 's1', intent: 'Lire', pre: {}, post: [], derived_from_untrusted: true }], runInput: {} });
    await host.handle({ action: 'begin', index: 0 }, tools());
    await expect(host.handle({ action: 'extract', index: 0 }, tools())).rejects.toBeInstanceOf(SandboxBridgeError);
    expect(host.info.failure).toMatchObject({ index: 0, failure: { failure_class: 'extraction', detail: 'response_too_large' } });
    expect(host.records).toEqual([]);
    expect(Math.max(0, ...transfers)).toBeLessThan(200_000);
  }, 60_000);

  test('page ordinaire : la même vue (rôles, noms normalisés, texte) qu’avant la borne', async () => {
    const plain = await browser.newPage();
    try {
      await plain.setContent('<!doctype html><html lang="fr"><body><h1>  Catalogue\n du jour </h1><nav><a href="/p2">Page   suivante</a><a href="/p3" aria-label="Autre">x</a><button>OK</button><input type="search" placeholder="Recherche"></nav><p>Titre : Vélo rouge</p></body></html>');
      const host = new StepsHost({ spec, source: [{ id: 's1', intent: 'Lire', pre: {}, post: [], derived_from_untrusted: true }], runInput: {} });
      const obs = await host.agentPage({ ...tools(), page: plain }, {}).observe();
      expect(obs.elements).toEqual([
        { role: 'heading', name: 'Catalogue du jour' },
        { role: 'link', name: 'Page suivante' },
        { role: 'link', name: 'Autre' },
        { role: 'button', name: 'OK' },
        { role: 'searchbox', name: 'Recherche' },
      ]);
      expect(obs.text).toContain('Titre : Vélo rouge');
    } finally {
      await plain.close();
    }
  }, 60_000);
});
