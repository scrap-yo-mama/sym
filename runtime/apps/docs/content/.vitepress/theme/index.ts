// SPDX-License-Identifier: AGPL-3.0-only
// Thème : le thème par défaut de VitePress, plus (1) le lien vers llms.txt et la version Markdown dans chaque page (16 § 4),
// (2) la recherche Pagefind dans la barre latérale. Composants écrits en fonctions de rendu : pas de SFC à compiler ici.
import { useData, withBase, type Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { defineComponent, h, onMounted } from 'vue';
import './custom.css';

/** « Pour les LLM » : llms.txt et la page en Markdown. Rendu côté serveur, donc présent dans le HTML construit. */
const LlmsFooter = defineComponent({
  name: 'LlmsFooter',
  setup() {
    const { page } = useData();
    return () =>
      h('p', { class: 'llms-footer' }, [
        'Pour les LLM : ',
        h('a', { href: withBase('/llms.txt') }, 'llms.txt'),
        ' · ',
        h('a', { href: withBase(`/${page.value.relativePath}`), rel: 'alternate', type: 'text/markdown' }, 'cette page en Markdown'),
      ]);
  },
});

type PagefindUiConstructor = new (options: Record<string, unknown>) => unknown;

/** Interface par défaut de Pagefind, chargée depuis le site lui-même ; sans index (mode `dev`), la boîte reste vide. */
const SearchBox = defineComponent({
  name: 'SearchBox',
  setup() {
    onMounted(() => {
      const w = window as unknown as { PagefindUI?: PagefindUiConstructor };
      const mount = (): void => {
        if (!w.PagefindUI) return;
        new w.PagefindUI({
          element: '#pagefind-search',
          showSubResults: true,
          showImages: false,
          translations: { placeholder: 'Rechercher dans la doc', clear_search: 'Effacer', zero_results: 'Aucun résultat pour [SEARCH_TERM]', many_results: '[COUNT] résultats pour [SEARCH_TERM]', one_result: '[COUNT] résultat pour [SEARCH_TERM]' },
        });
      };
      if (w.PagefindUI) return mount();
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = withBase('/pagefind/pagefind-ui.css');
      document.head.appendChild(css);
      const script = document.createElement('script');
      script.src = withBase('/pagefind/pagefind-ui.js');
      script.onload = mount;
      script.onerror = () => undefined;
      document.head.appendChild(script);
    });
    return () => h('div', { id: 'pagefind-search', class: 'search-box', role: 'search' });
  },
});

export default {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'doc-after': () => h(LlmsFooter), 'sidebar-nav-before': () => h(SearchBox) }),
} satisfies Theme;
