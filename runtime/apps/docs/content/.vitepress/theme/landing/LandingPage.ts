// SPDX-License-Identifier: AGPL-3.0-only
// Page d'accueil de la landing (22 § 2.2) : une page par langue, mêmes ids d'ancres dans les deux. Un seul bouton plein par vue.
// Composants : ChatReplay (démo enregistrée, 22 § 2.4), CopyCommand (commande de démarrage, 22 § 2.3).
import { SymSignature } from '@runtime/ui';
import { defineComponent, h, nextTick, ref, type PropType, type VNodeChild } from 'vue';
import type { Chrome, DemoMessage, LandingPage as Page } from '../../../../src/landing/types.ts';
import { anchorLink, button, renderFooter, renderHeader, skipLink, withGhost } from './parts.ts';

/** Bloc de commande avec bouton « Copier » : sans JavaScript, le bloc reste sélectionnable (22b : « Copier » sans `eval`). */
const CopyCommand = defineComponent({
  name: 'LpCopyCommand',
  props: { command: { type: Object as PropType<Page['hero']['command']>, required: true } },
  setup(props) {
    const copied = ref(false);
    const pre = ref<HTMLElement | null>(null);
    const select = (): void => {
      const target = pre.value;
      if (!target) return;
      const range = document.createRange();
      range.selectNodeContents(target);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };
    const copy = async (): Promise<void> => {
      try {
        await navigator.clipboard.writeText(props.command.text);
      } catch {
        select();
        return;
      }
      copied.value = true;
      setTimeout(() => {
        copied.value = false;
      }, 2000);
    };
    return () =>
      h('div', { class: 'lp-command sym-on-ink', id: 'commande' }, [
        h('p', { class: 'lp-command__label', id: 'commande-label' }, props.command.label),
        h('pre', { class: 'lp-command__code', ref: pre, tabindex: 0, role: 'region', 'aria-labelledby': 'commande-label' }, [h('code', props.command.text)]),
        h('div', { class: 'lp-command__bar' }, [
          h('button', { type: 'button', class: 'lp-btn lp-btn--outline', onClick: copy }, props.command.copy),
          h('span', { class: 'lp-command__status', role: 'status', 'aria-live': 'polite' }, copied.value ? props.command.copied : ''),
        ]),
        h('p', { class: 'lp-command__hint' }, props.command.hint),
      ]);
  },
});

/** Replay étiqueté de la démo : texte réel dans le HTML, animation CSS jouée une fois, pause et rejeu (WCAG 2.2.2). */
const ChatReplay = defineComponent({
  name: 'LpChatReplay',
  props: { demo: { type: Object as PropType<Page['demo']>, required: true }, lang: { type: String as PropType<Chrome['lang']>, required: true } },
  setup(props) {
    const paused = ref(false);
    const resetting = ref(false);
    const root = ref<HTMLElement | null>(null);
    const replay = async (): Promise<void> => {
      // L'état passe par la classe réactive (et non par classList) : Vue réécrit l'attribut class à chaque rendu.
      paused.value = false;
      resetting.value = true;
      await nextTick();
      void root.value?.offsetWidth;
      resetting.value = false;
    };
    const bubble = (message: DemoMessage, index: number): VNodeChild =>
      h('li', { class: ['lp-msg', `lp-msg--${message.from}`, `lp-msg--n${index + 1}`] }, [
        message.from === 'user' ? h('span', { class: 'lp-visually-hidden' }, `${props.demo.you} : `) : null,
        message.signature ? h(SymSignature, { variant: 'speaking', locale: props.lang }) : null,
        message.signature ? ' ' : null,
        h('span', { class: 'lp-msg__text' }, message.text),
      ]);
    return () =>
      h('div', { class: 'lp-demo-box' }, [
        h('p', { class: 'lp-demo-caption' }, props.demo.caption),
        h('ol', { class: ['lp-chat', paused.value ? 'is-paused' : '', resetting.value ? 'is-reset' : ''], ref: root, 'aria-label': props.demo.title }, props.demo.messages.map(bubble)),
        h('div', { class: 'lp-demo-controls' }, [
          h('button', { type: 'button', class: 'lp-btn lp-btn--outline', 'aria-pressed': String(paused.value), onClick: () => (paused.value = !paused.value) }, paused.value ? props.demo.resume : props.demo.pause),
          h('button', { type: 'button', class: 'lp-btn lp-btn--outline', onClick: replay }, props.demo.replay),
        ]),
        h('details', { class: 'lp-transcript' }, [
          h('summary', props.demo.transcript),
          h('ul', props.demo.messages.map((message) => h('li', [h('strong', message.from === 'user' ? `${props.demo.you} : ` : 'SYM : '), message.text]))),
        ]),
      ]);
  },
});

const heading = (level: 2 | 3, id: string, text: string): VNodeChild => h(`h${level}`, { id }, text);

export const LandingContent = defineComponent({
  name: 'LandingContent',
  props: { chrome: { type: Object as PropType<Chrome>, required: true }, page: { type: Object as PropType<Page>, required: true } },
  setup(props) {
    return () => {
      const { chrome, page } = props;
      const hero = page.hero;
      const sections: VNodeChild[] = [
        h('section', { id: 'hero', class: 'lp-hero', 'aria-labelledby': 'hero-title' }, [
          h('div', { class: 'lp-container lp-hero__grid' }, [
            h('div', { class: 'lp-hero__text' }, [
              h('p', { class: 'lp-eyebrow' }, hero.eyebrow),
              h('h1', { id: 'hero-title' }, withGhost(hero.title)),
              h('p', { class: 'lp-lead' }, hero.definition),
              h('p', { class: 'lp-sub' }, hero.sub),
              h('div', { class: 'lp-cta-row' }, hero.ctas.map(button)),
              h(CopyCommand, { command: hero.command }),
              h('ul', { class: 'lp-links' }, hero.links.map((link) => h('li', [anchorLink(link)]))),
            ]),
            h('div', { class: 'lp-hero__art', 'aria-hidden': 'true' }, [h('span', { class: 'lp-shape lp-shape--circle' }), h('span', { class: 'lp-shape lp-shape--square' }), h('span', { class: 'lp-shape lp-shape--dot' })]),
          ]),
        ]),
        h('section', { id: page.demo.id, class: 'lp-section', 'aria-labelledby': 'demo-title' }, [h('div', { class: 'lp-container' }, [heading(2, 'demo-title', page.demo.title), h(ChatReplay, { demo: page.demo, lang: chrome.lang })])]),
        h('section', { id: page.banner.id, class: 'lp-banner sym-on-ink' }, [
          h('div', { class: 'lp-container' }, [h('p', { class: 'lp-banner__hook' }, hookLines(page.banner.hook)), h('p', { class: 'lp-banner__sub' }, page.banner.sub)]),
        ]),
        h('section', { id: page.proof.id, class: 'lp-section', 'aria-labelledby': 'proof-title' }, [
          h('div', { class: 'lp-container' }, [
            heading(2, 'proof-title', page.proof.title),
            h('ul', { class: 'lp-proof' }, page.proof.items.map((item) => h('li', { class: 'lp-card' }, [h('p', item.text), item.link ? h('p', [anchorLink(item.link)]) : null]))),
          ]),
        ]),
        h('section', { id: page.how.id, class: 'lp-section', 'aria-labelledby': 'how-title' }, [
          h('div', { class: 'lp-container' }, [heading(2, 'how-title', page.how.title), h('ol', { class: 'lp-steps' }, page.how.steps.map((step) => h('li', { class: 'lp-card lp-step' }, [h('h3', step.title), h('p', step.text)])))]),
        ]),
        h('section', { id: page.cost.id, class: 'lp-section', 'aria-labelledby': 'cost-title' }, [
          h('div', { class: 'lp-container' }, [
            heading(2, 'cost-title', page.cost.title),
            h('p', page.cost.text),
            h('ol', { class: 'lp-ladder' }, page.cost.ladder.map((rung) => h('li', rung))),
            h('p', page.cost.replay),
          ]),
        ]),
        h('section', { id: page.far.id, class: 'lp-far sym-on-ink', 'aria-labelledby': 'far-title' }, [
          h('div', { class: 'lp-container' }, [
            h('h2', { id: 'far-title' }, page.far.title),
            h('p', { class: 'lp-far__hook' }, withGhost(page.far.hook)),
            h('p', { class: 'lp-far__sub' }, page.far.sub),
            h('ul', { class: 'lp-far__cards' }, page.far.cards.map((card) => h('li', { class: 'lp-card lp-card--ink' }, [h('h3', card.title), h('p', card.text)]))),
          ]),
        ]),
        h('section', { id: page.install.id, class: 'lp-section', 'aria-labelledby': 'install-title' }, [
          h('div', { class: 'lp-container' }, [
            heading(2, 'install-title', page.install.title),
            h(
              'ul',
              { class: 'lp-install' },
              page.install.cards.map((card) =>
                h('li', { class: 'lp-card' }, [h('h3', card.title), h('p', card.text), h('p', { class: 'lp-muted' }, card.prereq), h('p', { class: 'lp-muted' }, card.result), h('p', { class: 'lp-card__actions' }, [button(card.cta), anchorLink(card.guide)])]),
              ),
            ),
            h('div', { class: 'lp-install__more' }, [
              h('div', { class: 'lp-card' }, [h('h3', page.install.mcp.title), h('p', page.install.mcp.text)]),
              h('div', { class: 'lp-card' }, [h('p', page.install.demo.text), h('p', [anchorLink(page.install.demo.link)])]),
            ]),
          ]),
        ]),
        page.compare
          ? h('section', { id: page.compare.id, class: 'lp-section', 'aria-labelledby': 'compare-title' }, [
              h('div', { class: 'lp-container' }, [
                heading(2, 'compare-title', page.compare.title),
                h('div', { class: 'lp-table-wrap', role: 'region', tabindex: 0, 'aria-labelledby': 'compare-title' }, [
                  h('table', { class: 'lp-table' }, [
                    h('thead', [h('tr', [h('td'), ...page.compare.columns.map((column) => h('th', { scope: 'col' }, column))])]),
                    h('tbody', page.compare.rows.map((row) => h('tr', [h('th', { scope: 'row' }, row.label), ...row.cells.map((cell) => h('td', cell))]))),
                  ]),
                ]),
              ]),
            ])
          : null,
        h('section', { id: page.faq.id, class: 'lp-section', 'aria-labelledby': 'faq-title' }, [
          h('div', { class: 'lp-container' }, [
            heading(2, 'faq-title', page.faq.title),
            h(
              'div',
              { class: 'lp-faq' },
              page.faq.entries.map((entry) => h('div', { class: 'lp-faq__item' }, [h('h3', entry.question), h('p', entry.answer), entry.link ? h('p', [anchorLink(entry.link)]) : null])),
            ),
          ]),
        ]),
        h('section', { id: page.community.id, class: 'lp-section', 'aria-labelledby': 'community-title' }, [
          h('div', { class: 'lp-container' }, [heading(2, 'community-title', page.community.title), h('p', page.community.text), h('ul', { class: 'lp-links lp-links--row' }, page.community.links.map((link) => h('li', [anchorLink(link)])))]),
        ]),
      ];
      return h('div', { class: 'lp' }, [skipLink(chrome), renderHeader(chrome), h('main', { id: 'main', tabindex: -1 }, sections), renderFooter(chrome)]);
    };
  },
});

/** L'accroche est un seul texte du registre : deux lignes à l'écran, une seule phrase pour qui lit le texte brut. */
function hookLines(hook: string): VNodeChild[] {
  const index = hook.search(/(?<=\.)\s/);
  if (index < 0) return withGhost(hook);
  return [h('span', { class: 'lp-banner__line' }, hook.slice(0, index)), ' ', h('span', { class: 'lp-banner__line' }, withGhost(hook.slice(index + 1)))];
}
