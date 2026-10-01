// SPDX-License-Identifier: AGPL-3.0-only
// Alertes actionnables (08 § 5) : quelles transitions, regroupement, texte. Étage U1.
import { describe, expect, test } from 'vitest';
import { alertCauseForTransition, alertGroupKey, renderAlertEmail, type AlertDigest } from './index.js';

describe('alertCauseForTransition', () => {
  test.each([
    ['erreur', 'status_erreur'],
    ['action_requise', 'status_action_requise'],
    ['bloquee', 'status_bloquee'],
  ] as const)('vers %s : alerte', (to, cause) => expect(alertCauseForTransition(to)).toBe(cause));

  test.each(['sain', 'warning', 'enquete', 'reparation'] as const)('vers %s : pas d\'alerte (pas chaque run dégradé)', (to) =>
    expect(alertCauseForTransition(to)).toBeNull());

  test('une clé de regroupement par API et par cause', () => {
    expect(alertGroupKey('a1', 'status_erreur')).toBe('alert:a1:status_erreur');
    expect(alertGroupKey('a1', 'status_erreur')).not.toBe(alertGroupKey('a1', 'status_bloquee'));
    expect(alertGroupKey('a1', 'status_erreur')).not.toBe(alertGroupKey('a2', 'status_erreur'));
  });
});

describe('renderAlertEmail', () => {
  const digest: AlertDigest = {
    api: 'zz_test_annonces',
    api_id: 'a1',
    cause: 'status_bloquee',
    transitions: [{ from: 'sain', to: 'bloquee', reason: 'blocked_by_protection', at: '2026-10-01T10:00:00.000Z' }],
    run_id: 'r1',
    failure_class: 'blocked_by_protection',
    base_url: 'https://runtime.example/',
  };

  test('API, run, classe d\'échec et lien console', () => {
    const { subject, text } = renderAlertEmail(digest, 'en');
    expect(subject).toBe('[Scrapyomama] zz_test_annonces: blocked by the site');
    expect(text).toContain('API: zz_test_annonces');
    expect(text).toContain('Run: r1');
    expect(text).toContain('Failure class: blocked_by_protection');
    expect(text).toContain('Console: https://runtime.example/apis/zz_test_annonces');
  });

  test('bloquee : ton factuel, aucune proposition réseau (INV6, X4)', () => {
    for (const locale of ['en', 'fr'] as const) {
      const { text } = renderAlertEmail(digest, locale);
      expect(text).not.toMatch(/tunnel|proxy|résidentiel|residential|contourn|bypass|retry now|relancer/i);
    }
    expect(renderAlertEmail(digest, 'fr').text).toContain('l\'adresse IP ne change pas');
  });

  test('regroupement : le nombre de transitions apparaît, une seule alerte', () => {
    const grouped = { ...digest, cause: 'status_erreur' as const, transitions: [digest.transitions[0]!, { ...digest.transitions[0]!, from: 'warning' as const, to: 'erreur' as const, at: '2026-10-01T10:02:00.000Z' }] };
    const { text } = renderAlertEmail(grouped, 'fr');
    expect(text).toContain('Transitions : 2');
  });

  test('sans base d\'URL, pas de lien', () => {
    expect(renderAlertEmail({ ...digest, base_url: null }, 'en').text).not.toContain('Console');
  });

  test('e-mail localisé : sujet, corps et lang du HTML dans la langue demandée (M9), repli en pour une langue inconnue', () => {
    const fr = renderAlertEmail(digest, 'fr');
    expect(fr.subject).toBe('[Scrapyomama] zz_test_annonces : bloquée par le site');
    expect(fr.html).toContain('<html lang="fr">');
    expect(fr.lang).toBe('fr');
    expect(renderAlertEmail(digest, 'zz').lang).toBe('en');
    for (const message of [renderAlertEmail(digest, 'en'), fr]) expect(`${message.subject}${message.text}${message.html}`).not.toMatch(/[{}]|undefined|<img/);
  });
});
