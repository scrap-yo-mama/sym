// SPDX-License-Identifier: AGPL-3.0-only
// Fiche qualité du run et avis du juge (tâche 2.12, 19 §3, sur l'OpenAPI spécifiée comme 3.4) : l'avis est marqué
// « consultatif », il ne propose aucune action qui change le statut ou la version ; une valeur `x-personal` n'a que
// des formes (remplissage, sentinelles, motifs, longueurs).
import { describe, expect, test } from 'vitest';
import en from '@runtime/i18n/locales/en.json';
import fr from '@runtime/i18n/locales/fr.json';
import { esc, view } from '@/testing/console.testkit';
import RunQualityCard from './RunQualityCard.vue';

const quality = {
  items: 20,
  duplicates: 0,
  duplicate_rate: 0,
  fields: {
    price: { type: 'number', personal: false, suspected_personal: false, fill_rate: 1, sentinel_rate: 0, top_pattern: '99', unique_rate: 0.9, constant: false, length: { min: 2, max: 3, mean: 2.5 }, min: 10, max: 99 },
    seller: { type: 'string', personal: true, suspected_personal: false, fill_rate: 0.95, sentinel_rate: 0.05, top_pattern: 'Aa Aa', unique_rate: 1, constant: false, length: { min: 5, max: 20, mean: 11 } },
  },
};
const judge = { flag: true, trigger: 'anomaly', verdicts: [{ field: 'price', verdict: 'wrong', indices: [2], reason: 'prix à 0' }] };

describe('fiche qualité et juge consultatif', () => {
  for (const [locale, messages] of [['en', en], ['fr', fr]] as const) {
    test(`${locale} : un run avec judge_flag montre l'avis « consultatif », sans action qui change statut ou version`, async () => {
      const html = await view(RunQualityCard, { quality, judge, degradedReasons: ['field_constant'] }, { locale });
      expect(html).toContain('data-testid="run-quality"');
      expect(html).toContain('data-testid="judge-advisory"');
      expect(html).toContain(esc(messages.quality.judge.advisory));
      expect(messages.quality.judge.advisory.toLowerCase()).toMatch(locale === 'fr' ? /consultatif/ : /advisory/);
      expect(html).toContain(esc(messages.quality.judge.unchanged));
      expect(html).toContain('prix à 0');
      // Aucune action : ni bouton ni lien (promotion, retour de version, blocage) dans la fiche.
      expect(html).not.toMatch(/<button|<a\b/);
      // x-personal : formes seulement.
      const seller = html.slice(html.indexOf('data-field="seller"'));
      expect(seller.slice(0, seller.indexOf('</tr>'))).not.toMatch(/data-testid="field-min"|data-testid="field-max"/);
    });
  }

  test('sans juge : aucune section d’avis', async () => {
    const html = await view(RunQualityCard, { quality, judge: null, degradedReasons: [] }, { locale: 'fr' });
    expect(html).not.toContain('data-testid="judge-advisory"');
  });
});
