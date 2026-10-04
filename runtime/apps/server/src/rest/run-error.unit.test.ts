// SPDX-License-Identifier: AGPL-3.0-only
// UX-04 : la cause stable d'un run en échec est publiée avec son message, sa marche à suivre et `retryable`.
import { describe, expect, test } from 'vitest';
import { runErrorFor, runErrorOf, runInvestigationFailed, runNotStarted } from './run-error.js';

describe('cause d’un run en échec (UX-04)', () => {
  test('instance_contact_missing : code stable, message lisible, what_to_do, retryable', () => {
    const error = runErrorOf({ state: 'failed', error_detail: 'instance_contact_missing' });
    expect(error).toEqual({
      code: 'instance_contact_missing',
      message: 'Renseigne le contact du robot dans Réglages > Identité du robot, ou la variable INSTANCE_CONTACT.',
      what_to_do: expect.stringContaining('/settings/robot'),
      retryable: true,
    });
    expect(runErrorFor('instance_contact_missing')).toEqual(error);
  });

  test('UX-12 — llm_price_missing:<modèle> (run arrêté AVANT l’appel) : modèle nommé, « aucun appel », message terminé par un point', () => {
    const error = runErrorOf({ state: 'failed', error_detail: 'llm_price_missing:claude-opus-4-8' });
    expect(error).toEqual({
      code: 'llm_price_missing',
      message: 'Renseigne le prix du modèle claude-opus-4-8 dans Réglages > Modèles IA.',
      what_to_do: expect.stringContaining('Settings > AI models'),
      retryable: true,
    });
    expect(error?.what_to_do).toContain('claude-opus-4-8');
    expect(error?.what_to_do).toContain('no model call was made and nothing was spent');
    // Seul un nom de modèle plausible est publié (INV8 : jamais un détail libre).
    expect(runErrorOf({ state: 'failed', error_detail: 'llm_price_missing:https://zz-test.example/secret?k=1' })).toMatchObject({ message: 'Renseigne le prix du modèle utilisé dans Réglages > Modèles IA.' });
  });

  test('revue fix-ux-11 — llm_price_missing sans modèle (run déjà exécuté, hors enquête) : le modèle a été appelé, coût inconnu (null), jamais « aucun appel »', () => {
    const error = runErrorOf({ state: 'failed', error_detail: 'llm_price_missing' });
    expect(error).toMatchObject({ code: 'llm_price_missing', retryable: true });
    expect(error?.what_to_do).toContain('was called');
    expect(error?.what_to_do).toContain('unknown (null');
    expect(error?.what_to_do).not.toMatch(/no model call was made|nothing was spent/);
    expect(error?.message).toMatch(/coût.*inconnu/i);
    expect(error?.message.endsWith('.')).toBe(true);
  });

  test('runNotStarted : vrai seulement pour les causes qui arrêtent le run avant tout appel', () => {
    expect(runNotStarted({ state: 'failed', error_detail: 'instance_contact_missing' })).toBe(true);
    expect(runNotStarted({ state: 'failed', error_detail: 'llm_price_missing:zz-model' })).toBe(true);
    expect(runNotStarted({ state: 'failed', error_detail: 'llm_price_missing' })).toBe(false);
    expect(runNotStarted({ state: 'failed', error_detail: 'https://zz-test.example/secret' })).toBe(false);
    expect(runNotStarted({ state: 'succeeded', error_detail: 'instance_contact_missing' })).toBe(false);
  });

  test('contact posé mais invalide : même raison (instance_contact_missing), message qui dit de le corriger, jamais « renseigne-le »', () => {
    const error = runErrorOf({ state: 'failed', error_detail: 'instance_contact_invalid' });
    expect(error).toMatchObject({ code: 'instance_contact_missing', retryable: true });
    expect(error!.message).toContain('invalide');
    expect(error!.message).not.toMatch(/^Renseigne/);
    expect(error!.what_to_do).toContain('/settings/robot');
    expect(runErrorFor('instance_contact_invalid')).toEqual(error);
  });

  test('un run qui n’a pas échoué, ou un détail non nommé, ne publie aucune cause', () => {
    expect(runErrorOf({ state: 'succeeded', error_detail: 'instance_contact_missing' })).toBeNull();
    expect(runErrorOf({ state: 'failed', error_detail: 'https://zz-test.example/secret' })).toBeNull();
    expect(runErrorOf({ state: 'failed', error_detail: null })).toBeNull();
  });
});

// Recette 2026-10-04 (UX-29, UX-32) : « budget d'enquête épuisé » affiché pour un essai au-dessus de max_cost_usd ou une
// enquête sans stratégie conforme. Chaque fin a son code (celui de la raison de statut), son message et sa suite.
describe('fins d’échec d’enquête : cause exacte et suite proposée (UX-29, UX-32)', () => {
  test('plafond d’essai, aucune conforme, budget, durée : codes de la transition 2, jamais « could not start »', () => {
    const cases = [
      ['trial_cost_over_cap', 'trial_cost_over_cap', /max_cost_usd/],
      ['no_conformant_strategy', 'no_conformant_strategy', /timeline/],
      ['investigation_budget_usd', 'investigation_budget_exhausted', /budget_usd/],
      ['investigation_timeout_s', 'investigation_timeout', /timeout_s/],
    ] as const;
    for (const [detail, code, hint] of cases) {
      const run = { state: 'failed', error_detail: detail };
      expect(runErrorOf(run)).toMatchObject({ code, retryable: false, what_to_do: expect.stringMatching(hint) });
      expect(runNotStarted(run)).toBe(false);
      expect(runInvestigationFailed(run)).toBe(true);
    }
    expect(runInvestigationFailed({ state: 'failed', error_detail: 'instance_contact_missing' })).toBe(false);
  });
});

describe('UX-15 (U1.12) — réglages IA illisibles par le worker', () => {
  test('llm_settings_unreadable:<raison> : cause propre, raison nommée, ni « prix manquant » ni « non configuré »', () => {
    const error = runErrorOf({ state: 'failed', error_detail: 'llm_settings_unreadable:key_unreadable' });
    expect(error).toMatchObject({ code: 'llm_settings_unreadable', retryable: true });
    expect(error?.message).toContain('key_unreadable');
    expect(error?.message).toContain('Ma stack');
    expect(error?.what_to_do).toContain('MASTER_KEY');
    expect(error?.what_to_do).toContain('no model call was made');
    expect(runNotStarted({ state: 'failed', error_detail: 'llm_settings_unreadable:key_unreadable' })).toBe(true);
  });
  test('une raison qui n’a pas la forme d’un code n’est jamais recopiée (INV8)', () => {
    const error = runErrorOf({ state: 'failed', error_detail: 'llm_settings_unreadable:fournisseur zz-secret : clé illisible' });
    expect(error?.message).not.toContain('zz-secret');
    expect(error?.message).toContain('unknown');
  });
});

describe('U3.4 — tunnel perdu en cours de run (tunnel_lost)', () => {
  test('run ignoré `skipped_tunnel_offline` avec la cause tunnel_lost : cause lisible, action « Relancer », retryable', () => {
    const error = runErrorOf({ state: 'skipped_tunnel_offline', error_detail: 'tunnel_lost' });
    expect(error).toMatchObject({ code: 'tunnel_lost', retryable: true });
    expect(error?.message).toMatch(/relance/i);
    expect(error?.what_to_do).toContain('run_api');
  });
  test('extension jamais connectée (tunnel_offline) : inchangé, pas de cause nommée ici', () => {
    expect(runErrorOf({ state: 'skipped_tunnel_offline', error_detail: 'tunnel_offline' })).toBeNull();
  });
  test('tunnel_lost sur un run en échec : même cause', () => {
    expect(runErrorOf({ state: 'failed', error_detail: 'tunnel_lost' })).toMatchObject({ code: 'tunnel_lost' });
  });
});
