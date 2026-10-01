// SPDX-License-Identifier: AGPL-3.0-only
// Lecture de l'élément qui a le focus, pour les tests au clavier (keyboard.e2e.ts, live-regions.e2e.ts). Rien ici n'agit sur la
// page : ces fonctions ne font que lire.
import type { Page } from '@playwright/test';

export type Stop = { tag: string; name: string; id: string; href: string; ring: boolean; outline: string; inViewport: boolean };

/** L'élément qui a le focus : balise, nom lisible, et si son anneau de focus est celui des jetons (2 px pleins, couleur --ring). */
export async function focused(page: Page): Promise<Stop> {
  // Un anneau absent à la première lecture est relu quelques fois : la règle de mouvement réduit (transition de 0,01 ms) et les champs
  // de date (focus dans le champ interne) laissent le style un instant en retard. Un anneau réellement absent reste absent.
  let stop = await readFocused(page);
  for (let retry = 0; retry < 5 && !stop.ring && stop.tag !== 'body'; retry += 1) {
    await page.waitForTimeout(100);
    stop = await readFocused(page);
  }
  return stop;
}

async function readFocused(page: Page): Promise<Stop> {
  return page.evaluate(async () => {
    // Deux images d'attente : la règle de mouvement réduit (0,01 ms) laisse une transition en cours d'une image sur l'anneau.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { tag: 'body', name: '', id: '', href: '', ring: false, outline: '', inViewport: true };
    const probe = document.createElement('i');
    probe.style.color = 'var(--ring)';
    document.body.append(probe);
    const ringColor = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    const label =
      el.getAttribute('aria-label') ||
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
      el.textContent ||
      el.getAttribute('placeholder') ||
      el.getAttribute('name') ||
      '';
    const outline = `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor} (anneau attendu : ${ringColor})`;
    return {
      tag: el.tagName.toLowerCase(),
      name: label.replace(/\s+/g, ' ').trim().slice(0, 80),
      id: el.id,
      href: el.getAttribute('href') ?? '',
      // Le bouton de calendrier d'un champ de date est un contrôle interne du navigateur : le champ n'y est plus :focus-visible et
      // c'est le navigateur qui dessine l'indicateur sur l'icône. Partout ailleurs, l'anneau est celui des jetons.
      ring:
        (el instanceof HTMLInputElement && ['date', 'time', 'datetime-local', 'month', 'week'].includes(el.type) && !el.matches(':focus-visible')) ||
        (style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) >= 2 && style.outlineColor === ringColor),
      outline,
      inViewport: box.bottom > 0 && box.right > 0 && box.top < window.innerHeight && box.left < window.innerWidth,
    };
  });
}

/** Identité de l'élément qui a le focus, pour vérifier qu'une annonce ne le déplace pas. */
export const activeElement = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName}#${el.id}.${el.getAttribute('data-testid') ?? ''}` : 'none';
  });
