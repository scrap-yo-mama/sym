// SPDX-License-Identifier: AGPL-3.0-only
// D-123 (2026-10-05) : plus de plafond de coût par run par défaut. La fiche (propriétaire) montre un champ « coût max par
// run » facultatif : vide = aucun plafond (le budget du jour du compte reste la limite), un nombre = un plafond, effaçable.
// Le serveur reste juge (400 cost_cap_exceeded au-delà de MAX_COST_USD_PER_RUN).
import { effectScope, type EffectScope } from 'vue';
import { afterEach, describe, expect, test } from 'vitest';
import RunCostCapForm from '@/components/api/RunCostCapForm.vue';
import ApiOverviewTab from '@/components/api/tabs/ApiOverviewTab.vue';
import { parseCostCap, useRunCostCap } from '@/composables/useRunCostCap';
import en from '@runtime/i18n/locales/en.json';
import fr from '@runtime/i18n/locales/fr.json';
import { setApi } from '@/lib/api';
import { apiDetail, installApi, json, renderHtml, textOf } from '@/testing/console-fixtures';

const SLUG = 'zz-cost-cap';

const scopes: EffectScope[] = [];
function inScope<T>(run: () => T): T {
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(run) as T;
}
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  setApi(undefined);
});

describe('coût max par run : facultatif, vide par défaut (D-123)', () => {
  test('saisie : vide = aucun plafond ; nombre ≥ 0 = plafond ; le reste est refusé sans requête', () => {
    expect(parseCostCap('')).toBeNull();
    expect(parseCostCap('   ')).toBeNull();
    expect(parseCostCap('1.5')).toBe(1.5);
    expect(parseCostCap('0,25')).toBe(0.25);
    expect(parseCostCap('-1')).toBe('invalid');
    expect(parseCostCap('abc')).toBe('invalid');
  });

  test('sans plafond : champ vide, phrase « aucun plafond », pas de bouton Retirer', async () => {
    const html = await renderHtml(RunCostCapForm, { detail: apiDetail({ slug: SLUG, max_cost_usd: null }), slug: SLUG });
    expect(html).toContain('data-testid="cost-cap-input"');
    expect(html).not.toMatch(/data-testid="cost-cap-input"[^>]*value="[^"]/);
    expect(textOf(html)).toContain(fr.costCap.none);
    expect(html).not.toContain('data-testid="cost-cap-clear"');
  });

  test('plafond fixé : valeur affichée et bouton Retirer le plafond', async () => {
    const html = await renderHtml(RunCostCapForm, { detail: apiDetail({ slug: SLUG, max_cost_usd: 2 }), slug: SLUG }, 'en');
    expect(html).toMatch(/data-testid="cost-cap-input"[^>]*value="2"|value="2"[^>]*data-testid="cost-cap-input"/);
    expect(textOf(html)).toContain(en.costCap.clear);
  });

  test('enregistrer : PATCH max_cost_usd (nombre, ou null pour retirer) ; refus du serveur gardé en code stable', async () => {
    const bodies: unknown[] = [];
    let status = 200;
    installApi({
      [`PATCH /api/apis/${SLUG}`]: async (request) => {
        const body = (await request.json()) as { max_cost_usd: number | null };
        bodies.push(body);
        return status === 200 ? json(200, apiDetail({ slug: SLUG, max_cost_usd: body.max_cost_usd })) : json(status, { error: { code: 'cost_cap_exceeded', message: 'x' } });
      },
    });
    const cap = inScope(() => useRunCostCap(SLUG));
    expect((await cap.save('1.5'))?.max_cost_usd).toBe(1.5);
    expect((await cap.save(''))?.max_cost_usd).toBeNull();
    expect(await cap.save('-3')).toBeNull();
    expect(cap.invalid.value).toBe(true);
    status = 400;
    expect(await cap.save('5000')).toBeNull();
    expect(cap.error.value?.code).toBe('cost_cap_exceeded');
    expect(bodies).toEqual([{ max_cost_usd: 1.5 }, { max_cost_usd: null }, { max_cost_usd: 5000 }]);
    expect(fr.apiErrors.cost_cap_exceeded).toMatch(/plafond/);
  });

  test('vue d’ensemble : le champ pour le propriétaire (max_cost_usd présent, même null), jamais pour un lecteur d’une API partagée', async () => {
    const owner = await renderHtml(ApiOverviewTab, { detail: apiDetail({ slug: SLUG, max_cost_usd: null }), slug: SLUG });
    expect(owner).toContain('data-testid="cost-cap-form"');
    const reader = await renderHtml(ApiOverviewTab, { detail: apiDetail({ slug: SLUG }), slug: SLUG });
    expect(reader).not.toContain('data-testid="cost-cap-form"');
  });

  test('budget du jour atteint au lancement : message clair (réinitialisation, admin), fr et en', () => {
    expect(fr.apiErrors.budget_exceeded).toMatch(/minuit UTC/);
    expect(fr.apiErrors.budget_exceeded).toMatch(/admin/);
    expect(en.apiErrors.budget_exceeded).toMatch(/00:00 UTC/);
    expect(en.apiErrors.budget_exceeded).toMatch(/admin/);
  });
});
