// SPDX-License-Identifier: AGPL-3.0-only
// Charte SYM dans la console construite (tâche 3.15, 20b § 3.1) : assert_fonts_self_hosted (0 requête vers un domaine tiers à
// froid, polices servies par l'instance), assert_sym_signature_rendering (icône de packages/ui en aria-hidden à côté du texte
// « SYM », jamais l'emoji, jamais « sym » en minuscules), assert_reduced_motion_respected (prefers-reduced-motion et réglage
// Animations). assert_no_csp_violation est porté par la fixture : la console est servie avec sa CSP stricte et TOUT test
// de la console (dont ceux-ci) échoue au premier `securitypolicyviolation`.
import type { Page } from '@playwright/test';
import { test, expect } from './console.fixture.ts';
import { SCREENS } from './screens.ts';

const FONT_LOADED = `(async () => {
  await document.fonts.ready;
  return [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family.replace(/["']/g, '') + ' ' + face.weight);
})()`;

const loadedFonts = (page: Page): Promise<string[]> => page.evaluate(FONT_LOADED) as Promise<string[]>;

test.describe('assert_fonts_self_hosted', () => {
  test.use({ uiLocale: 'fr', uiTheme: 'light' });

  test('à froid, la console et un écran de données ne font aucune requête vers un domaine tiers ; les polices viennent de l’instance', async ({ consolePage }) => {
    const { page, app, open } = consolePage;
    const origin = new URL(app.url).origin;
    const foreign: string[] = [];
    const fonts: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return;
      if (new URL(url).origin !== origin) foreign.push(url);
      if (request.resourceType() === 'font') fonts.push(url);
    });
    await open('/login', { anonymous: true });
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    expect(await loadedFonts(page)).toEqual(expect.arrayContaining(['Bricolage Grotesque 800', 'DM Sans 400']));
    await open('/apis');
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    expect(foreign, 'requêtes vers un domaine tiers').toEqual([]);
    expect(fonts.length).toBeGreaterThan(0);
    for (const url of fonts) expect(new URL(url).pathname, url).toMatch(/^\/assets\/[a-z0-9-]+-[\w-]+\.woff2$/);
  });

  test('JetBrains Mono ne part que sur un écran qui affiche du code : pas sur la connexion, oui sur la clé d’API révélée', async ({ consolePage }) => {
    const { page, app, open } = consolePage;
    await open('/login', { anonymous: true });
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    expect((await loadedFonts(page)).filter((font) => font.startsWith('JetBrains Mono'))).toEqual([]);

    const screen = SCREENS.find((candidate) => candidate.id === 'settings-keys-created');
    if (!screen) throw new Error('écran settings-keys-created introuvable');
    await open(screen.path, { routes: screen.routes });
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    await screen.prepare?.(page, app);
    expect((await loadedFonts(page)).filter((font) => font.startsWith('JetBrains Mono')).length).toBeGreaterThan(0);
  });

  test('les titres sont en Bricolage Grotesque, le texte en DM Sans, les cartes ont 20 px de rayon', async ({ consolePage }) => {
    const { page, app, open } = consolePage;
    await open('/login', { anonymous: true });
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    const styles = await page.evaluate(() => ({
      heading: getComputedStyle(document.querySelector('h1') as Element).fontFamily,
      body: getComputedStyle(document.body).fontFamily,
      card: getComputedStyle(document.querySelector('[data-slot="card"]') as Element).borderTopLeftRadius,
    }));
    expect(styles.heading).toMatch(/^"?Bricolage Grotesque"?,/);
    expect(styles.body).toMatch(/^"?DM Sans"?,/);
    expect(styles.card).toBe('20px');
  });

  test('la barre de navigation est l’anthracite de la maquette (#24252D) en clair, la surface relevée (#2F3039) en sombre', async ({ consolePage }) => {
    const { page, app, open } = consolePage;
    const barColor = (): Promise<string> => page.evaluate(() => getComputedStyle(document.querySelector('header.sym-on-ink') as Element).backgroundColor);
    await open('/login', { anonymous: true });
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    expect(await barColor()).toBe('rgb(36, 37, 45)');
    await page.evaluate(() => document.documentElement.classList.add('dark'));
    expect(await barColor()).toBe('rgb(47, 48, 57)');
  });
});

test.describe('assert_no_csp_violation', () => {
  test('témoin : la CSP est bien servie et une violation est bien relevée (le contrôle sait donc échouer), puis le relevé est vidé', async ({ consolePage }) => {
    const { page, app, open, cspViolations } = consolePage;
    await open('/login', { anonymous: true });
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    expect(cspViolations).toEqual([]);
    const header = await page.evaluate(async () => (await fetch('/')).headers.get('content-security-policy'));
    expect(header).toContain("style-src 'self'");
    // Un style en ligne est refusé par `style-src 'self'` : la fixture doit l'avoir vu.
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = 'body { outline: 1px solid; }';
      document.head.append(style);
    });
    await expect.poll(() => cspViolations.length).toBeGreaterThan(0);
    expect(cspViolations[0]).toContain('style-src');
    cspViolations.length = 0;
  });
});

/** Parcourt le DOM de la page : emoji, « sym » en minuscules, et structure de chaque signature. */
const SIGNATURE_AUDIT = `(() => {
  const problems = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent || '';
    if (text.includes('\\u{1F47B}')) problems.push('emoji dans un nœud texte : ' + text.trim().slice(0, 40));
    if (/\\bsym\\b/.test(text)) problems.push('« sym » en minuscules : ' + text.trim().slice(0, 40));
  }
  for (const el of document.querySelectorAll('[title], [aria-label], [alt], [placeholder]')) {
    for (const name of ['title', 'aria-label', 'alt', 'placeholder']) {
      if ((el.getAttribute(name) || '').includes('\\u{1F47B}')) problems.push('emoji dans l’attribut ' + name);
    }
  }
  const signatures = [...document.querySelectorAll('[data-sym-signature]')];
  for (const sig of signatures) {
    const icons = sig.querySelectorAll('svg');
    if (icons.length !== 1 || icons[0].getAttribute('aria-hidden') !== 'true') problems.push('icône : un svg aria-hidden attendu');
    const label = sig.querySelector('.sym-signature__text');
    if (!label || label.textContent !== 'SYM') problems.push('texte « SYM » attendu à côté de l’icône');
    const colon = [...sig.querySelectorAll('span[aria-hidden="true"]')];
    const variant = sig.getAttribute('data-variant');
    if (variant === 'badge' && colon.length > 0) problems.push('badge : pas de deux-points');
    if (variant === 'speaking' && !(colon.length === 1 && /^[\\u00A0]?:$/.test(colon[0].textContent || ''))) problems.push('SYM parle : deux-points attendu');
    if (sig.closest('[data-testid="status-badge"], [data-testid="blocked-panel"], [role="alert"], [data-testid="confirm-panel"]')) problems.push('signature dans une zone interdite (statut, Bloquée, erreur, confirmation)');
  }
  return { problems, count: signatures.length, zones: signatures.map((s) => s.parentElement && s.parentElement.tagName) };
})()`;

/** Écrans qui montrent la bulle de la carte d'illustration (connexion sans erreur, premier démarrage, étapes suivantes) ; tous les autres, erreurs comprises, n'en ont pas. */
const BUBBLE_SCREENS = ['login', 'login-second-factor', 'setup', 'setup-next'];

test.describe('assert_sym_signature_rendering', () => {
  test.use({ uiLocale: 'fr', uiTheme: 'dark' });

  for (const screen of SCREENS) {
    test(screen.id, async ({ consolePage }) => {
      const { page, app, open } = consolePage;
      await open(screen.path, { anonymous: screen.anonymous, routes: screen.routes });
      await expect(page.locator('h1').first()).toBeVisible();
      await app.settled();
      await screen.prepare?.(page, app);
      const audit = (await page.evaluate(SIGNATURE_AUDIT)) as { problems: string[]; count: number };
      expect(audit.problems).toEqual([]);
      // Une signature de marque par écran (la barre de navigation) ; la bulle « SYM : » de la carte d'illustration (3.21) est la
      // seule autre, sur quatre écrans, jamais sur une erreur : jamais plus d'une par zone d'écran (20 § 2.3).
      const bubbles = await page.locator('[data-sym-bubble] [data-sym-signature][data-variant="speaking"]').count();
      expect(bubbles, 'bulle de SYM').toBe(BUBBLE_SCREENS.includes(screen.id) ? 1 : 0);
      expect(audit.count).toBe(1 + bubbles);
    });
  }
});

/** Insère une carte de test animée (apparition et coche tracée) : de quoi voir tourner, ou non, la couche d'animations de packages/ui. */
const INSERT_PROBE = `(() => {
  const probe = document.createElement('div');
  probe.id = 'zz-motion-probe';
  probe.className = 'sym-fade-in';
  probe.innerHTML = '<svg class="sym-check" viewBox="0 0 24 24" width="24" height="24"><path d="M5 12l5 5L20 7" fill="none" stroke="currentColor" stroke-width="3"></path></svg>';
  document.body.append(probe);
})()`;

const MOTION_STATE = `(() => {
  const probe = document.getElementById('zz-motion-probe');
  const path = probe.querySelector('path');
  return {
    running: document.getAnimations().filter((animation) => animation.playState === 'running').length,
    fadeName: getComputedStyle(probe).animationName,
    checkName: getComputedStyle(path).animationName,
    opacity: getComputedStyle(probe).opacity,
    dashOffset: getComputedStyle(path).strokeDashoffset,
    motionAttribute: document.documentElement.getAttribute('data-motion'),
  };
})()`;

type MotionState = { running: number; fadeName: string; checkName: string; opacity: string; dashOffset: string; motionAttribute: string | null };

test.describe('assert_reduced_motion_respected', () => {
  test.use({ uiLocale: 'fr', uiTheme: 'light' });

  async function probeAt(page: Page): Promise<MotionState> {
    await page.evaluate(INSERT_PROBE);
    return (await page.evaluate(MOTION_STATE)) as MotionState;
  }

  test('témoin : sans préférence de mouvement, la couche d’animations tourne (le test sait donc échouer)', async ({ consolePage }) => {
    const { page, app, open } = consolePage;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await open('/apis');
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    const state = await probeAt(page);
    expect(state.fadeName).toBe('sym-fade-in');
    expect(state.checkName).toBe('sym-check-draw');
    expect(state.running).toBeGreaterThan(0);
  });

  test('prefers-reduced-motion: reduce : aucune animation en cours, état final affiché', async ({ consolePage }) => {
    const { page, app, open } = consolePage;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open('/apis');
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
    const state = await probeAt(page);
    expect(state).toMatchObject({ running: 0, fadeName: 'none', checkName: 'none', opacity: '1', dashOffset: '0px' });
  });

  test('réglage Animations « Réduites » de Mon compte (système sans préférence) : même résultat, mémorisé et posé avant le premier rendu', async ({ consolePage }) => {
    const { page, app, open } = consolePage;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    // 20 § 4.3 : le réglage vit dans Mon compte, pas dans la barre du haut.
    await open('/apis');
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    await expect(page.locator('header #pref-motion')).toHaveCount(0);
    await open('/settings/account');
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    await expect(page.getByLabel('Animations', { exact: true })).toHaveValue('system');
    await page.locator('#pref-motion').selectOption('reduced');
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-motion'))).toBe('reduced');
    let state = await probeAt(page);
    expect(state).toMatchObject({ running: 0, fadeName: 'none', checkName: 'none', opacity: '1', dashOffset: '0px' });

    // Rechargée : l'attribut est déjà là avant que la console ne se monte (public/theme-init.js).
    await page.reload();
    await expect(page.locator('h1').first()).toBeVisible();
    await app.settled();
    await expect(page.locator('#pref-motion')).toHaveValue('reduced');
    await page.evaluate(() => document.getElementById('zz-motion-probe')?.remove());
    state = await probeAt(page);
    expect(state).toMatchObject({ running: 0, motionAttribute: 'reduced', fadeName: 'none', checkName: 'none' });

    // Retour à « Système » : la couche d'animations reprend.
    await page.locator('#pref-motion').selectOption('system');
    await page.evaluate(() => document.getElementById('zz-motion-probe')?.remove());
    state = await probeAt(page);
    expect(state.fadeName).toBe('sym-fade-in');
  });
});
