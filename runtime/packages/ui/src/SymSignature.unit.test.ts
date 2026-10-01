// SPDX-License-Identifier: AGPL-3.0-only
// assert_sym_signature_rendering, volet composant (20b § 3.1, E1/E2 pour le rendu réel) : l'icône SVG de packages/ui est
// décorative et placée à côté du texte « SYM » ; le deux-points n'existe que quand SYM parle (précédé d'une espace insécable
// en français) et reste muet pour les lecteurs d'écran ; jamais l'emoji dans le DOM ; jamais « sym » en minuscules.
import { createSSRApp, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, test } from 'vitest';
import SymSignature from './SymSignature.vue';
import { SYM_GHOST_PATH } from './sym-ghost.ts';

const render = (props: { variant?: 'speaking' | 'badge'; locale?: 'en' | 'fr' }): Promise<string> => renderToString(createSSRApp({ render: () => h(SymSignature, props) }));

describe('SymSignature', () => {
  test('badge : icône décorative + texte « SYM », sans deux-points', async () => {
    const html = await render({ variant: 'badge' });
    expect(html).toContain('data-sym-signature');
    expect(html).toContain('data-variant="badge"');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toContain(`d="${SYM_GHOST_PATH}"`);
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('<span class="sym-signature__text">SYM</span>');
    expect(html.replace(/<[^>]+>/g, '')).toBe('SYM');
  });

  test('SYM parle en anglais : « SYM: », le deux-points masqué aux lecteurs d’écran', async () => {
    const html = await render({ variant: 'speaking', locale: 'en' });
    expect(html).toContain('<span aria-hidden="true">:</span>');
    expect(html.replace(/<[^>]+>/g, '')).toBe('SYM:');
  });

  test('SYM parle en français : espace insécable avant le deux-points', async () => {
    const html = await render({ variant: 'speaking', locale: 'fr' });
    expect(html).toContain('<span aria-hidden="true"> :</span>');
    expect(html.replace(/<[^>]+>/g, '')).toBe('SYM :');
  });

  test("jamais l'emoji ni « sym » en minuscules dans le rendu", async () => {
    for (const variant of ['badge', 'speaking'] as const) {
      const text = (await render({ variant })).replace(/<[^>]+>/g, '');
      expect(text).not.toContain('\u{1F47B}');
      expect(text).not.toMatch(/\bsym\b/);
    }
  });
});
