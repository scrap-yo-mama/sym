// SPDX-License-Identifier: AGPL-3.0-only
// assert_console_matches_maquette_wording et assert_console_visual_language (3.21, D-60) : les écrans de la console qui n'ont pas
// de planche (connexion, premier démarrage, réglages, comptes, audit, runs, fiche API, panneau Bloquée) reprennent le langage
// visuel des planches (barre anthracite, titre Bricolage de 44 à 54 px, pastille de rubrique, carte d'illustration bleue à formes,
// bulle « SYM 👻 : ») et les mots de la maquette (navigation, bouton jaune, bulle, pastilles). La relecture côte à côte des captures
// reste humaine ; ce test garde ce qui se mesure : les libellés mot pour mot et la structure.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import en from './i18n/locales/en.json';
import fr from './i18n/locales/fr.json';
import { visibleNav } from './lib/nav';

const SRC = dirname(fileURLToPath(import.meta.url));
const read = (path: string): string => readFileSync(join(SRC, path), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const sourcesOf = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? sourcesOf(join(dir, name)) : name.endsWith('.vue') ? [join(dir, name)] : []));

describe('assert_console_matches_maquette_wording', () => {
  test('navigation : « Démarrage », « Catalogue », « Runs », « Réglages » et « Nouvelle API », comme la planche Démarrage', () => {
    expect(fr.nav.home).toBe('Démarrage');
    expect(fr.nav.catalog).toBe('Catalogue');
    expect(fr.nav.runs).toBe('Runs');
    expect(fr.nav.settings).toBe('Réglages');
    expect(fr.nav.newApi).toBe('Nouvelle API');
    expect(en.nav.runs).toBe('Runs');
  });

  test('« Nouvelle API » est le bouton jaune à place fixe à droite de la barre, pas un lien de la liste', () => {
    const entries = visibleNav(() => true, false);
    expect(entries.filter((entry) => entry.cta).map((entry) => entry.label)).toEqual(['nav.newApi']);
    const app = read('App.vue');
    expect(app).toContain('data-testid="nav-cta"');
    expect(app).toMatch(/bg-signature[^"]*text-signature-foreground/);
    expect(app).toMatch(/filter\(\(entry\) => !entry\.cta\)/);
  });

  test('la bulle et les pastilles reprennent les mots de la planche, la signature en icône', () => {
    expect(fr.brand.bubble.onIt).toBe('OK, je m\'en occupe.');
    expect(fr.brand.bubble.done).toBe('C\'est fait.');
    expect([fr.brand.pills.fetch, fr.brand.pills.browser, fr.brand.pills.agent]).toEqual(['Fetch', 'Navigateur', 'Agent']);
    const card = read('components/brand/SymIllustration.vue');
    expect(card).toMatch(/<SymSignature[^>]*variant="speaking"/);
    expect(card).not.toContain('\u{1F47B}');
  });

  test('chaque clé de la marque existe dans les deux langues', () => {
    expect(Object.keys(fr.brand.kicker).sort()).toEqual(Object.keys(en.brand.kicker).sort());
    expect(Object.keys(fr.brand.pills).sort()).toEqual(Object.keys(en.brand.pills).sort());
    expect(Object.keys(fr.brand.bubble).sort()).toEqual(Object.keys(en.brand.bubble).sort());
  });
});

describe('assert_console_visual_language', () => {
  test('connexion et premier démarrage : deux colonnes, titre de page et carte d’illustration', () => {
    for (const view of ['views/LoginView.vue', 'views/SetupView.vue']) {
      const source = read(view);
      expect(source, view).toContain('lg:grid-cols-2');
      expect(source, view).toContain('<PageHeader');
      expect(source, view).toContain('<SymIllustration');
    }
  });

  test('aucune bulle de SYM sur une erreur : la connexion et le formulaire de premier démarrage la retirent quand un message d’erreur s’affiche', () => {
    expect(read('views/LoginView.vue')).toMatch(/:bubble="errorText \? undefined/);
    expect(read('views/SetupView.vue')).toMatch(/:bubble="errorText \? undefined/);
  });

  test('runs, audit, utilisateurs : en-tête de page (pastille + titre Bricolage) ; réglages et fiche API : titre et pastille', () => {
    for (const view of ['views/RunsView.vue', 'views/admin/AuditView.vue', 'views/admin/UsersView.vue']) expect(read(view), view).toContain('<PageHeader');
    expect(read('views/settings/SettingsView.vue')).toContain('sym-kicker');
    expect(read('components/api/ApiDetailPage.vue')).toContain('sym-kicker');
  });

  test('plus aucun titre de page en text-2xl : tous les <h1> portent le titre de la marque (44 à 54 px, Bricolage)', () => {
    const offenders = sourcesOf(SRC)
      .filter((file) => !file.endsWith('.test.ts'))
      .flatMap((file) => [...readFileSync(file, 'utf8').matchAll(/<h1\b[^>]*class="([^"]*)"/g)].map((match) => ({ file: file.replace(`${SRC}/`, ''), cls: match[1] ?? '' })))
      .filter(({ file, cls }) => !cls.includes('sym-title') && !/^(views\/(Home|NewApi|ApiCatalog)View\.vue|components\/brand\/)/.test(file));
    expect(offenders).toEqual([]);
    const css = read('assets/main.css').replace(/\n/g, ' ');
    expect(css).toMatch(/@utility sym-title \{[^}]*font-display[^}]*text-\[2\.75rem\][^}]*sm:text-\[3\.375rem\]/);
  });

  test('la carte d’illustration n’est qu’un décor : formes en aria-hidden, aucune couleur écrite en dur', () => {
    const card = read('components/brand/SymIllustration.vue');
    expect(card.match(/aria-hidden="true"/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(card).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
    expect(card).toContain('bg-sym-blue');
    expect(card).toContain('bg-sym-orange');
    expect(card).toContain('bg-sym-lilac');
    expect(card).toContain('bg-sym-yellow');
  });

  test('le panneau Bloquée reste nu : ni signature, ni illustration, ni bulle', () => {
    for (const panel of ['components/BlockedPanel.vue', 'components/api/BlockedPanel.vue']) {
      const source = read(panel);
      expect(source, panel).not.toMatch(/SymSignature|SymIllustration|data-sym-/);
      expect(source, panel).not.toContain('bg-sym-');
    }
  });
});
