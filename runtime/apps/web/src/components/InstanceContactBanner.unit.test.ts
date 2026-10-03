// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment vue-client
// UX-06 : tant que le contact d'instance manque (requis avant la première enquête, 17 § 5), le catalogue et « Nouvelle API »
// montrent un bandeau avec un lien vers Réglages > Identité du robot. Rien quand le contact est posé, quand le worker n'a pas
// encore publié son environnement (rien d'inventé), ni pour un membre qui ne peut pas régler l'identité.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { components } from '@runtime/client';
import { resetSession, ensureSession } from '@/composables/useSession';
import { setApi } from '@/lib/api';
import ApiCatalogView from '@/views/ApiCatalogView.vue';
import NewApiView from '@/views/NewApiView.vue';
import { installApi, json, textOf } from '@/testing/console-fixtures';
import { mountHtml, type MountedHtml } from '@/testing/memory-mount';
import { ROLE_PERMISSIONS } from '@/testing/permissions';

type Identity = components['schemas']['IdentitySettings'];
const mounted: MountedHtml[] = [];

const ME = {
  id: '3f2b6c1e-0000-4000-8000-000000000001',
  email: 'ada@x.test',
  displayName: 'Ada',
  role: 'owner',
  locale: 'fr',
  theme: 'system',
  via: 'ui',
  scopes: null,
  permissions: ROLE_PERMISSIONS.owner,
  mfaEnabled: false,
  mfaRequired: false,
  mfaEnrollmentRequired: false,
};

const identity = (overrides: Partial<Identity> = {}): Identity => ({
  identify_instance: null,
  identify_effective: false,
  identify_source: 'default',
  instance_contact: null,
  instance_contact_effective: null,
  instance_contact_source: null,
  engine: { version: '153.0.8010.12', platform: 'linux' },
  worker_version: '1.0.0',
  user_agent: null,
  user_agent_identified: null,
  product_version: '1.0.0',
  ...overrides,
});

/** Serveur factice : session ouverte pour `permissions`, identité servie, requêtes enregistrées. */
function serve(current: Identity, permissions: readonly string[] = ME.permissions): string[] {
  return installApi({
    'GET /api/auth/get-session': () => json(200, { session: { id: 's' }, user: { id: ME.id, email: ME.email } }),
    'GET /api/me': () => json(200, { ...ME, permissions }),
    'GET /api/apis': () => json(200, { apis: [], next_cursor: null }),
    'GET /api/settings/identity': () => json(200, current),
  });
}

async function open(view: typeof ApiCatalogView | typeof NewApiView): Promise<MountedHtml> {
  await ensureSession();
  const page = await mountHtml(view, {}, 'fr');
  mounted.push(page);
  return page;
}

beforeEach(() => resetSession());
afterEach(() => {
  for (const page of mounted.splice(0)) page.unmount();
  vi.unstubAllGlobals();
  setApi(undefined);
  resetSession();
});

describe('bandeau « contact du robot » (UX-06)', () => {
  test.each([
    ['le catalogue', ApiCatalogView],
    ['Nouvelle API', NewApiView],
  ] as const)('%s : contact absent → bandeau « requis avant la première enquête » et lien vers Réglages > Identité du robot', async (_name, view) => {
    serve(identity());
    const html = (await open(view)).html();
    expect(html).toContain('data-testid="instance-contact-banner"');
    expect(html).toMatch(/<a[^>]*href="\/settings\/robot"/);
    expect(textOf(html)).toContain('Renseigne le contact du robot');
    expect(textOf(html)).toContain('Réglages > Identité du robot');
  });

  test('contact posé (réglage ou variable d’environnement du worker) : aucun bandeau', async () => {
    serve(identity({ instance_contact: 'mailto:ops@zz-test.example', instance_contact_effective: 'mailto:ops@zz-test.example', instance_contact_source: 'setting' }));
    expect((await open(ApiCatalogView)).html()).not.toContain('instance-contact-banner');
    serve(identity({ instance_contact_effective: 'mailto:env@zz-test.example', instance_contact_source: 'env' }));
    expect((await open(NewApiView)).html()).not.toContain('instance-contact-banner');
  });

  test('aucun worker n’a publié son environnement : rien d’inventé, aucun bandeau', async () => {
    serve(identity({ engine: null }));
    expect((await open(ApiCatalogView)).html()).not.toContain('instance-contact-banner');
  });

  test('un membre (sans le droit de régler l’identité) : aucun bandeau et aucune lecture de l’identité', async () => {
    const seen = serve(identity(), ROLE_PERMISSIONS.member);
    expect((await open(ApiCatalogView)).html()).not.toContain('instance-contact-banner');
    expect(seen.some((entry) => entry.includes('/api/settings/identity'))).toBe(false);
  });

  test('lecture de l’identité refusée ou en panne : la page reste, sans bandeau', async () => {
    installApi({
      'GET /api/auth/get-session': () => json(200, { session: { id: 's' }, user: { id: ME.id, email: ME.email } }),
      'GET /api/me': () => json(200, ME),
      'GET /api/apis': () => json(200, { apis: [], next_cursor: null }),
      'GET /api/settings/identity': () => json(403, { error: { code: 'forbidden', message: 'x' } }),
    });
    expect((await open(ApiCatalogView)).html()).not.toContain('instance-contact-banner');
  });
});
