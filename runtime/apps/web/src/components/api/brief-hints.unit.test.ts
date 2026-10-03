// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment vue-client
// Liste des indices du dossier d'enquête de la fiche API (tâche 2.14, 19c § 7) : état, raison, coût et version du dossier
// posés par le code, version lue par chaque version de stratégie ; 404 (API d'un autre membre) lu comme « aucun dossier » ;
// aucun texte du dossier, aucune commande.
import { afterEach, describe, expect, test } from 'vitest';
import BriefHintsList from '@/components/api/BriefHintsList.vue';
import { setApi } from '@/lib/api';
import fr from '@/i18n/locales/fr.json';
import { controls, installApi, json } from '@/testing/console-fixtures';
import { mountHtml, type MountedHtml } from '@/testing/memory-mount';

const mounted: MountedHtml[] = [];
afterEach(() => {
  for (const page of mounted.splice(0)) page.unmount();
  setApi(undefined);
});

async function render(slug: string): Promise<string> {
  const page = await mountHtml(BriefHintsList, { slug });
  mounted.push(page);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return page.html();
}

describe('BriefHintsList (2.14)', () => {
  test('indices avec état, raison, coût et version ; gabarit reconstruit ; version lue par chaque version de stratégie ; aucune commande', async () => {
    installApi({
      'GET /api/apis/zz-brief/brief': () =>
        json(200, {
          latest: { version: 2, created_at: '2026-10-03T10:00:00.000Z', hints: 3, tried: 1, open_questions: 1, erased: false },
          hints: [],
          versions: [
            { strategy_version: 2, brief_version: 2, used: 1, ignored: 1 },
            { strategy_version: 1, brief_version: null, used: 0, ignored: 0 },
          ],
          report: [
            { id: 'h1', kind: 'endpoint', state: 'used', reason: 'brief_used', provenance: 'probe', template: 'zz.example/api/items', stale: false, cost_usd: 0.0002 },
            { id: 'h2', kind: 'example_url', state: 'ignored', reason: 'brief_host_ignored', provenance: null, template: 'evil.example/x', stale: false, cost_usd: null },
            { id: 'h3', kind: 'selector', state: 'unverified', reason: 'brief_stale', provenance: null, template: null, stale: true, cost_usd: null },
          ],
        }),
    });
    const html = await render('zz-brief');
    expect(html).toContain('data-testid="brief-hints"');
    expect(html).toContain(fr.brief.reason.brief_used);
    expect(html).toContain(fr.brief.reason.brief_host_ignored);
    expect(html).toContain('zz.example/api/items');
    expect(html).toContain(fr.brief.state.unverified);
    expect(html).toContain(`(${fr.brief.stale})`);
    expect(html).toContain('v2 : dossier v2 (1 utilisés, 1 écartés)');
    expect(html).toContain('v1 : aucun dossier');
    expect(controls(html)).toEqual([]);
  });

  test('404 (API partagée d’un autre membre) : « aucun dossier », sans erreur ni commande', async () => {
    installApi({ 'GET /api/apis/zz-other/brief': () => json(404, { error: { code: 'not_found', message: 'ressource introuvable' } }) });
    const html = await render('zz-other');
    expect(html).toContain(fr.brief.empty);
    expect(controls(html)).toEqual([]);
  });
});
