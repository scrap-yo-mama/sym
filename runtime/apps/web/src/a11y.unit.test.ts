// SPDX-License-Identifier: AGPL-3.0-only
// Garde statique d'accessibilité de la console (WCAG 2.2 AA, 06 § 1, tâche 3.9). Les violations qui exigent un rendu réel
// (axe, parcours au clavier, annonces) sont jugées en Chromium par apps/web/e2e/*.e2e.ts ; ce fichier vérifie ce qu'on
// peut lire dans le code : motifs ARIA, couverture des écrans par la gate, textes non traduits.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { API_TABS } from '@/lib/api-tabs';
import { createAppRouter } from '@/router/index';

const webSrc = new URL('./', import.meta.url).pathname;

function files(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : files(full, pattern);
    return pattern.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

const vueFiles = files(webSrc, /\.vue$/);
const rel = (file: string): string => relative(webSrc, file);

describe('reflow à 320 px (WCAG 1.4.10)', () => {
  test('un conteneur à défilement horizontal est positionné (relative) : sinon le texte masqué (sr-only, absolu) d’un tableau déborde de la page', () => {
    const offenders: string[] = [];
    for (const file of vueFiles) {
      for (const match of readFileSync(file, 'utf8').matchAll(/<div\b[^>]*class="[^"]*\boverflow-x-auto\b[^"]*"/g)) if (!/\brelative\b/.test(match[0])) offenders.push(`${rel(file)} : ${match[0].slice(0, 90)}`);
    }
    expect(offenders).toEqual([]);
  });

  test('un bouton passe à la ligne au lieu de déborder : pas de whitespace-nowrap, hauteur minimale (min-h-*) et non fixe (h-*)', () => {
    const button = readFileSync(join(webSrc, 'components/ui/button/index.ts'), 'utf8');
    expect(button).not.toMatch(/whitespace-nowrap/);
    expect(button).toMatch(/max-w-full/);
    for (const size of ['default', 'xs', 'sm', 'lg']) {
      expect(button, `taille ${size}`).toMatch(new RegExp(`"?${size}"?:\\s*"min-h-\\d+ `));
    }
  });
});

describe('taille des cibles (WCAG 2.5.8 : 24 px au moins)', () => {
  test('chaque <summary> (déplier un nœud) a une hauteur minimale de 24 px (min-h-6) : la ligne de texte seule fait 20 px', () => {
    const offenders: string[] = [];
    for (const file of vueFiles) {
      for (const match of readFileSync(file, 'utf8').matchAll(/<summary\b[^>]*>/g)) if (!/\bmin-h-(6|7|8|9|10|11)\b/.test(match[0])) offenders.push(`${rel(file)} : ${match[0].slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('motifs ARIA', () => {
  test('un rôle ARIA ne remplace jamais le rôle de liste de <ol> ou <ul> : role="log" va sur un conteneur, la liste est dedans (axe listitem)', () => {
    const offenders: string[] = [];
    for (const file of vueFiles) {
      for (const match of readFileSync(file, 'utf8').matchAll(/<(ol|ul)\b[^>]*\srole="(?!list"|listbox"|menu"|tablist"|radiogroup")[^"]+"/g)) offenders.push(`${rel(file)} : ${match[0].slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });

  test('un bouton à bascule garde un seul signal : libellé qui change OU aria-pressed, jamais les deux', () => {
    const offenders: string[] = [];
    for (const file of vueFiles) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/<(Button|button)\b[^>]*aria-pressed[^>]*>([\s\S]*?)<\/\1>/g)) {
        // Libellé conditionnel : `{{ condition ? t('a') : t('b') }}` dans le contenu du bouton.
        if (/\{\{[^}]*\?[^}]*:[^}]*\}\}/.test(match[2] ?? '')) offenders.push(rel(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Contenu de `<template>` d'un composant (le dernier bloc racine), sans les commentaires HTML. */
function templateOf(file: string): string {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf('<template>');
  const end = text.lastIndexOf('</template>');
  return start === -1 ? '' : text.slice(start + '<template>'.length, end).replace(/<!--[\s\S]*?-->/g, '');
}

/** Noms de fichiers et de protocoles, identiques dans toutes les langues. */
const TECHNICAL_NAMES = new Set(['llms.txt', 'robots', 'robots.txt']);

/** Textes écrits en dur dans un gabarit : nœuds de texte et attributs lus par un lecteur d'écran (aria-label, title, placeholder, alt). */
function hardcodedText(rawTemplate: string): string[] {
  const found: string[] = [];
  // Moustaches retirées d'abord : une flèche `=>` ou un `<` dans une expression ne coupe pas le texte.
  const template = rawTemplate.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\{\{[\s\S]*?\}\}/g, ' ');
  for (const match of template.matchAll(/>([^<>]*)</g)) {
    const text = (match[1] ?? '').replace(/&[a-z]+;|&#\d+;/g, ' ').trim();
    if (/\p{L}{2,}/u.test(text) && !TECHNICAL_NAMES.has(text)) found.push(`texte « ${text} »`);
  }
  for (const match of template.matchAll(/\s(aria-label|aria-description|title|placeholder|alt)="([^"]*)"/g)) {
    if (/\p{L}{2,}/u.test(match[2] ?? '')) found.push(`${match[1]}="${match[2]}"`);
  }
  return found;
}

describe('textes visibles : tout passe par vue-i18n (parité en/fr)', () => {
  test('la détection voit un texte en dur et laisse passer une traduction', () => {
    expect(hardcodedText('<p>Bonjour</p>')).toEqual(['texte « Bonjour »']);
    expect(hardcodedText('<button aria-label="Fermer">x</button>')).toEqual(['aria-label="Fermer"']);
    expect(hardcodedText('<input placeholder="Rechercher" />')).toEqual(['placeholder="Rechercher"']);
    expect(hardcodedText('<p>{{ t(\'a.b\') }}</p><p :aria-label="t(\'a.c\')">{{ items.map((i) => i).join(\', \') }}</p><span>1</span><code>llms.txt</code>')).toEqual([]);
  });

  test('aucun texte écrit en dur dans un gabarit (hors composants shadcn copiés) : ni nœud de texte, ni aria-label, title, placeholder, alt littéraux', () => {
    const offenders = vueFiles.filter((file) => !rel(file).startsWith('components/ui/')).flatMap((file) => hardcodedText(templateOf(file)).map((text) => `${rel(file)} : ${text}`));
    expect(offenders).toEqual([]);
  });
});

// --- Garde de couverture de la gate (les jugements eux-mêmes sont rendus en Chromium : apps/web/e2e/*.e2e.ts) ---

const e2e = (name: string): string => readFileSync(new URL(`../e2e/${name}`, import.meta.url), 'utf8');

describe('assert_a11y_axe_clean : la gate axe couvre tous les écrans, thèmes et langues (jugement : e2e/a11y.e2e.ts)', () => {
  test('chaque route de la console a au moins un écran dans la gate', async () => {
    const { SCREENS } = await import('../e2e/screens.ts');
    const router = createAppRouter(createMemoryHistory());
    // Routes à rendu propre ; une route qui redirige seulement (`/settings` → modèles) n'a pas d'écran à juger.
    const named = router.getRoutes().filter((route) => route.name !== undefined).map((route) => String(route.name));
    const covered = new Set(SCREENS.map((screen: { path: string }) => String(router.resolve(screen.path).name)));
    expect(named.filter((name) => !covered.has(name))).toEqual([]);
    // La fiche d'une API a ses huit onglets, chacun en un écran de la gate.
    const tabs = SCREENS.filter((screen: { id: string }) => screen.id.startsWith('api-bloquee-')).map((screen: { path: string }) => screen.path.split('/').pop());
    expect(tabs).toEqual([...API_TABS]);
    // Les états qui ne sont pas l'écran nominal : vide, erreur, sans résultat, coupure du flux, enquête en direct, confirmation.
    const ids = SCREENS.map((screen: { id: string }) => screen.id);
    for (const id of ['catalog-empty', 'catalog-error', 'catalog-no-match', 'catalog-stream-down', 'new-api-investigating', 'api-sain-revert-confirm', 'login-error']) expect(ids).toContain(id);
  });

  test('axe tourne avec les quatre jeux de balises de 06 § 1, en clair et en sombre, en en et en fr, et refuse toute violation', () => {
    const gate = e2e('a11y.e2e.ts');
    for (const tag of ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']) expect(gate).toContain(`'${tag}'`);
    expect(gate).toMatch(/THEMES: Theme\[\] = \['light', 'dark'\]/);
    expect(gate).toMatch(/LOCALES: Locale\[\] = \['en', 'fr'\]/);
    expect(gate).toContain('assert_a11y_axe_clean');
    expect(gate).toMatch(/expect\(report, .*\)\.toEqual\(\[\]\)/);
  });
});

describe('assert_keyboard_only_path : le parcours au clavier n’emploie aucune action de souris (jugement : e2e/keyboard.e2e.ts)', () => {
  test('keyboard.e2e.ts n’appelle ni click, fill, check, hover, tap, selectOption ni mouse, et se déplace avec Tab', () => {
    const path = e2e('keyboard.e2e.ts').replace(/\/\/[^\n]*/g, '');
    expect(path).not.toMatch(/\.(click|fill|check|uncheck|hover|tap|selectOption|dblclick|dragTo)\(|\.mouse\.|\.focus\(\)/);
    expect(path).toContain("page.keyboard.press('Tab')");
    expect(path).toContain("page.keyboard.press('Enter')");
    expect(path).toContain('assert_keyboard_only_path');
  });
});

describe('assert_live_regions_plan : rôles ARIA du plan de 06 § 3 (jugement : e2e/live-regions.e2e.ts)', () => {
  const source = (name: string): string => readFileSync(join(webSrc, name), 'utf8');

  test('essais : role=log ; étape et état : role=status ; catalogue : role=status ; action requise et erreur : role=alert', () => {
    expect(source('components/investigation/AttemptLog.vue')).toMatch(/role="log"/);
    expect(source('components/api/ReplayPlayer.vue')).toMatch(/role="log"/);
    expect(source('components/investigation/InvestigationBoard.vue')).toMatch(/role="status"[^>]*data-testid="investigation-status"/);
    expect(source('views/ApiCatalogView.vue')).toMatch(/role="status" aria-live="polite" class="sr-only" data-testid="catalog-live"/);
    expect(source('components/ConnectionBanner.vue')).toMatch(/role="status" aria-live="polite"/);
    expect(source('components/investigation/ActionBanner.vue')).toMatch(/role="alert"/);
    expect(source('components/api/ActionRequiredBanner.vue')).toMatch(/section v-if="cause && !resuming" role="alert"/);
    expect(source('components/ErrorState.vue')).toMatch(/role="alert"/);
  });

  test('aucune annonce assertive, et seuls quatre endroits déplacent le focus d’eux-mêmes : le titre de route, le lien d’évitement, la confirmation en ligne (focus sur Annuler, puis retour à l’ouvreur) et « voir les essais »', () => {
    const offenders: string[] = [];
    const focusing: string[] = [];
    for (const file of [...vueFiles, ...files(webSrc, /\.ts$/)]) {
      const text = readFileSync(file, 'utf8');
      if (/aria-live="assertive"|aria-live: 'assertive'/.test(text)) offenders.push(rel(file));
      if (/\.focus\(\)/.test(text)) focusing.push(rel(file));
    }
    expect(offenders).toEqual([]);
    expect(focusing.sort()).toEqual(['App.vue', 'components/api/ConfirmPanel.vue', 'components/investigation/InvestigationBoard.vue', 'lib/focus-return.ts', 'router/index.ts']);
  });

  test('l’étape et la boucle de suivi ont leur bouton « Suspendre le suivi » (2.2.2) : enquête, replay et catalogue', () => {
    expect(source('components/investigation/InvestigationBoard.vue')).toContain('follow-toggle');
    expect(source('components/api/ReplayPlayer.vue')).toContain('suspend-follow');
    expect(source('views/ApiCatalogView.vue')).toContain('catalog-follow-toggle');
  });

  test('live-regions.e2e.ts exerce chaque zone du plan', () => {
    const live = e2e('live-regions.e2e.ts');
    for (const zone of ["role=\"log\"", "role=\"status\"", "role=\"alert\"", 'connection-banner', 'catalog-live', 'assert_live_regions_plan']) expect(live).toContain(zone);
  });
});

describe('assert_contrast_tokens : le test de jetons existe et couvre les deux thèmes (apps/web/src/design-tokens.unit.test.ts)', () => {
  test('les deux feuilles de jetons sont lues, avec 4,5:1 pour le texte et 3:1 pour bordures, anneau de focus et teintes de statut', () => {
    const tokens = readFileSync(join(webSrc, 'design-tokens.unit.test.ts'), 'utf8');
    expect(tokens).toContain('const TEXT = 4.5');
    expect(tokens).toContain('const NON_TEXT = 3');
    expect(tokens).toMatch(/\['light', 'dark'\]/);
    expect(tokens).toContain('STATUS_TONE');
  });
});
