// SPDX-License-Identifier: AGPL-3.0-only
// Briques de la landing, écrites en fonctions de rendu (pas de gabarit à compiler) : liens, icône SYM, en-tête, pied de page.
// Tout est rendu côté serveur, donc présent dans le HTML construit ; le navigateur n'ajoute que les interactions (thème, copie,
// pause de la démo). Aucun attribut `style` : la CSP de la page l'interdit (22 § 2.9).
import { SYM_GHOST_PATH, SYM_GHOST_VIEWBOX, SymSignature } from '@runtime/ui';
import { withBase } from 'vitepress';
import { defineComponent, h, onMounted, ref, type VNodeChild } from 'vue';
import { hrefOf, isFullLoad } from '../../../../src/landing/href.ts';
import type { Chrome, Cta, Href, Link } from '../../../../src/landing/types.ts';

/** Navigation native : une autre page du site (CSP de la page d'arrivée) ou une ancre (focus et saut du navigateur, sans le défilement animé du routeur). */
const isNativeNavigation = (href: Href): boolean => isFullLoad(href) || href.to === 'anchor';

/** Adresse d'un lien, avec le chemin de base du site (le routeur de VitePress n'est pas utilisé pour quitter la landing). */
const addressOf = (href: Href): string => (href.to === 'anchor' || href.to === 'external' ? hrefOf(href, '/') : withBase(hrefOf(href, '/')));

/** Icône SYM 👻 : le seul rendu de l'emoji (20 § 2.3), décorative, jamais dans `<title>`, `meta`, `og:*` ni JSON-LD. */
const ghostIcon = (): VNodeChild =>
  h('svg', { class: 'lp-ghost sym-signature__icon', xmlns: 'http://www.w3.org/2000/svg', viewBox: SYM_GHOST_VIEWBOX, fill: 'currentColor', 'aria-hidden': 'true', focusable: 'false', 'data-sym-ghost': '' }, [h('path', { 'fill-rule': 'evenodd', d: SYM_GHOST_PATH })]);

/** Texte où chaque 👻 devient l'icône de marque ; le texte lu reste complet sans elle. */
export function withGhost(text: string): VNodeChild[] {
  const parts = text.split('👻');
  return parts.flatMap((part, index) => (index < parts.length - 1 ? [part, ghostIcon()] : [part]));
}

export function anchorLink(link: Link): VNodeChild {
  return h('a', { href: addressOf(link.href), ...(isNativeNavigation(link.href) ? { class: 'vp-raw' } : {}), ...(link.href.to === 'external' ? { rel: 'noopener' } : {}) }, link.label);
}

export function button(cta: Cta): VNodeChild {
  return h('a', { class: ['lp-btn', `lp-btn--${cta.style}`, isNativeNavigation(cta.href) ? 'vp-raw' : ''], href: addressOf(cta.href) }, cta.label);
}

/** Bascule clair/sombre : n'écrit dans le stockage local qu'après un clic (22b : assert_landing_no_cookie). */
const ThemeToggle = defineComponent({
  name: 'LpThemeToggle',
  props: { label: { type: String, required: true } },
  setup(props) {
    const isDark = ref(false);
    onMounted(() => {
      isDark.value = document.documentElement.classList.contains('dark');
    });
    const toggle = (): void => {
      isDark.value = !isDark.value;
      document.documentElement.classList.toggle('dark', isDark.value);
      try {
        localStorage.setItem('vitepress-theme-appearance', isDark.value ? 'dark' : 'light');
      } catch {
        // Stockage refusé (navigation privée, réglage du navigateur) : le choix vaut pour cette page seulement.
      }
    };
    return () =>
      h('button', { type: 'button', class: 'lp-theme', 'aria-pressed': String(isDark.value), onClick: toggle }, [
        h('span', { class: 'lp-theme__icon', 'aria-hidden': 'true' }),
        h('span', { class: 'lp-visually-hidden' }, props.label),
      ]);
  },
});

export function renderHeader(chrome: Chrome): VNodeChild {
  const stars = chrome.github.stars;
  return h('header', { class: 'lp-header sym-on-ink' }, [
    h('div', { class: 'lp-container lp-header__inner' }, [
      h('a', { class: 'lp-brand vp-raw', href: addressOf({ to: 'home', lang: chrome.lang }) }, [h('span', { class: 'lp-brand__name' }, chrome.brand.name), h(SymSignature, { variant: 'badge', locale: chrome.lang })]),
      h('nav', { class: 'lp-nav', 'aria-label': chrome.labels.mainNav }, [h('ul', chrome.nav.map((link) => h('li', [anchorLink(link)])))]),
      h('div', { class: 'lp-tools' }, [
        h('a', { class: 'lp-tool', href: addressOf(chrome.github.href), rel: 'noopener' }, [chrome.github.label, stars === null ? null : h('span', { class: 'lp-stars' }, [h('span', { 'aria-hidden': 'true' }, '★ '), String(stars), h('span', { class: 'lp-visually-hidden' }, chrome.labels.stars)])]),
        h('a', { class: 'lp-tool vp-raw', href: addressOf(chrome.language.href), lang: chrome.language.hreflang, hreflang: chrome.language.hreflang }, chrome.language.label),
        h(ThemeToggle, { label: chrome.theme.dark }),
      ]),
    ]),
  ]);
}

export function renderFooter(chrome: Chrome): VNodeChild {
  return h('footer', { class: 'lp-footer sym-on-ink' }, [
    h('div', { class: 'lp-container' }, [
      h('nav', { 'aria-label': chrome.labels.footerNav }, [h('ul', { class: 'lp-footer__links' }, chrome.footer.links.map((link) => h('li', [anchorLink(link)])))]),
      h('ul', { class: 'lp-footer__languages', 'aria-label': chrome.labels.languages }, chrome.footer.languages.map((language) => h('li', [language.current ? h('span', { class: 'lp-current', lang: language.hreflang, 'aria-current': 'true' }, language.label) : h('a', { class: 'vp-raw', href: addressOf(language.href), lang: language.hreflang, hreflang: language.hreflang }, language.label)]))),
      h('p', { class: 'lp-footer__notice' }, chrome.footer.notice),
      h('p', { class: 'lp-footer__mark' }, chrome.footer.mark),
    ]),
  ]);
}

/** Lien d'évitement : navigation native du navigateur (focus déplacé sur <main>), pas le défilement du routeur. */
export const skipLink = (chrome: Chrome): VNodeChild => h('a', { class: 'lp-skip vp-raw', href: '#main' }, chrome.skip);

