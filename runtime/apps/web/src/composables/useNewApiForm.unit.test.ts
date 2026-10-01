// SPDX-License-Identifier: AGPL-3.0-only
// Formulaire « Nouvelle API » (06 § 2). `assert_account_site_warning` : pour un domaine à compte, l'avertissement A11 doit être
// confirmé avant la création ; le texte affiché est celui de 06 § 2, dans les deux langues.
import { describe, expect, test } from 'vitest';
import AccountSiteWarning from '@/components/investigation/AccountSiteWarning.vue';
import en from '@runtime/i18n/locales/en.json';
import fr from '@runtime/i18n/locales/fr.json';
import { esc, view } from '@/testing/console.testkit';
import { useNewApiForm } from './useNewApiForm';

function filled() {
  const api = useNewApiForm();
  api.form.description = '  Titres des annonces  ';
  api.form.url = 'https://www.exemple.test/liste';
  return api;
}

describe('saisie', () => {
  test('saisie minimale valide : description nettoyée, URL, politique réseau directe', () => {
    const { build, errors } = filled();
    expect(build()).toEqual({ description: 'Titres des annonces', url: 'https://www.exemple.test/liste', network_policy: { allow: ['direct'] } });
    expect(errors.value).toEqual({});
  });

  test('chaque champ invalide est signalé, aucune requête n’est construite', () => {
    const api = useNewApiForm();
    api.form.url = 'ftp://exemple.test';
    api.form.example = '{pas du json';
    api.form.direct = false;
    expect(api.build()).toBeNull();
    expect(api.errors.value).toEqual({ description: true, url: true, example: true, network: true });
    api.form.url = 'pas une url';
    api.build();
    expect(api.errors.value.url).toBe(true);
  });

  test('exemple de sortie : un objet ou un tableau JSON, joint au corps', () => {
    const api = filled();
    api.form.example = '[{"titre":"a","prix":3}]';
    expect(api.build()?.example_output).toEqual([{ titre: 'a', prix: 3 }]);
    api.form.example = '42';
    expect(api.build()).toBeNull();
    expect(api.errors.value.example).toBe(true);
  });

  test('politique réseau : modes cochés, pays du résidentiel sur 2 lettres, tunnel neutre', () => {
    const api = filled();
    api.form.dcProxy = true;
    api.form.resProxy = true;
    api.form.country = 'FR';
    api.form.tunnel = true;
    expect(api.build()?.network_policy).toEqual({ allow: ['direct', 'dc_proxy', 'res_proxy', 'tunnel'], res_proxy_params: { country: 'fr' } });
    api.form.country = 'france';
    expect(api.build()).toBeNull();
    expect(api.errors.value.country).toBe(true);
  });

  test('le tunnel choisi seul n’impose pas l’avertissement des sites à compte (réglage neutre)', () => {
    const api = filled();
    api.form.direct = false;
    api.form.tunnel = true;
    expect(api.build()).toMatchObject({ network_policy: { allow: ['tunnel'] } });
    expect(api.accountWarningShown.value).toBe(false);
  });
});

describe('assert_account_site_warning', () => {
  test('site déclaré à compte : la création est refusée tant que l’avertissement n’est pas confirmé', () => {
    const api = filled();
    api.form.accountDeclared = true;
    expect(api.accountWarningShown.value).toBe(true);
    expect(api.build()).toBeNull();
    expect(api.errors.value).toEqual({ account: true });
    api.form.accountConfirmed = true;
    expect(api.build()).toMatchObject({ account_site_acknowledged: true });
    expect(api.errors.value).toEqual({});
  });

  test('le serveur peut exiger la confirmation (account_site_ack_required) même si rien n’a été déclaré', () => {
    const api = filled();
    expect(api.build()).not.toHaveProperty('account_site_acknowledged');
    api.serverAsksAck.value = true;
    expect(api.accountWarningShown.value).toBe(true);
    expect(api.build()).toBeNull();
    api.form.accountConfirmed = true;
    expect(api.build()).toMatchObject({ account_site_acknowledged: true });
  });

  test('site sans compte : aucune confirmation, aucun drapeau dans la requête', () => {
    const api = filled();
    api.form.accountConfirmed = true; // sans effet : l'avertissement n'est pas affiché
    expect(api.build()).not.toHaveProperty('account_site_acknowledged');
  });

  test('l’avertissement affiche le texte de 06 § 2 (en et fr), un rappel de session personnelle et la case à confirmer', async () => {
    for (const [locale, text] of [['en', en], ['fr', fr]] as const) {
      const html = await view(AccountSiteWarning, { modelValue: false, error: false }, { locale });
      expect(html).toContain(esc(text.newApi.account.warning));
      expect(html).toContain(esc(text.newApi.account.ownSession));
      expect(html).toContain(esc(text.newApi.account.confirm));
      expect(html).toMatch(/type="checkbox"/);
      expect(html).not.toContain(' checked');
      expect(html).not.toContain('role="alert"');
    }
    const refused = await view(AccountSiteWarning, { modelValue: false, error: true });
    expect(refused).toContain(en.newApi.accountRequired);
    expect(refused).toContain('role="alert"');
    expect(await view(AccountSiteWarning, { modelValue: true })).toContain(' checked');
  });

  test('le texte français est celui du CDC', () => {
    expect(fr.newApi.account.warning).toBe(
      'Ce site demande un compte. Tes conditions d\'utilisation de la plateforme peuvent interdire l\'extraction automatisée et les données peuvent concerner des personnes (RGPD). Tu es responsable de l\'usage.',
    );
  });
});
