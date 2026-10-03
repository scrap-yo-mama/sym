// SPDX-License-Identifier: AGPL-3.0-only
// Pages juridiques de la landing (22 § 2.11) : même en-tête et même pied que l'accueil, le texte Markdown entre les deux.
import { Content } from 'vitepress';
import { defineComponent, h, type PropType } from 'vue';
import type { Chrome } from '../../../../src/landing/types.ts';
import { renderFooter, renderHeader, skipLink } from './parts.ts';

export const LegalContent = defineComponent({
  name: 'LegalContent',
  props: { chrome: { type: Object as PropType<Chrome>, required: true } },
  setup(props) {
    return () => h('div', { class: 'lp' }, [skipLink(props.chrome), renderHeader(props.chrome), h('main', { id: 'main', tabindex: -1 }, [h('div', { class: 'lp-container lp-prose' }, [h(Content)])]), renderFooter(props.chrome)]);
  },
});
