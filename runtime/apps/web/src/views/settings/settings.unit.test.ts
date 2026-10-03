// SPDX-License-Identifier: AGPL-3.0-only
// Réglages BYO (06 § 2, 08 § 7, tâche 3.5). `assert_secret_masked` : la clé d'un fournisseur n'apparaît jamais en clair dans le DOM
// rendu, n'est jamais relue, et le champ est vidé dès l'envoi. Les réponses réseau sont vérifiées côté serveur (08b) et en E2E (3.6).
import { readFileSync } from 'node:fs';
import type { components } from '@runtime/client';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { nextTick, watch } from 'vue';
import TestOutcome from '@/components/settings/TestOutcome.vue';
import { resetSession } from '@/composables/useSession';
import { LLM_PRESETS, useExtensionSettings, useLlmSettings, useProxies, useSmtp, useWebhooks } from '@/composables/useSettings';
import en from '@runtime/i18n/locales/en.json';
import { setApi } from '@/lib/api';
import { collectDiagnostic } from '@/lib/diagnostic';
import { buildApi } from '@/lib/api';
import { esc, installFakeServer, json, sessionRoutes, view } from '@/testing/console.testkit';
import AlertsSettingsView from './AlertsSettingsView.vue';
import ExtensionSettingsView from './ExtensionSettingsView.vue';
import ModelsSettingsView from './ModelsSettingsView.vue';
import ProxiesSettingsView from './ProxiesSettingsView.vue';

beforeEach(() => resetSession());
afterEach(() => {
  setApi(undefined);
  resetSession();
});

const SECRET = 'sk-zz_test_LEAK-4f9a1c7e';
const llmSettings = {
  providers: [
    // Un serveur défaillant qui renverrait la clé : la console ne doit ni la ranger ni l'afficher.
    { id: 'zai', preset: 'zai', base_url: 'https://api.z.test/v1', api_key_set: true, headers_set: true, api_key: SECRET, headers: { authorization: SECRET } },
    { id: 'local', preset: 'ollama', base_url: 'http://localhost:11434/v1', api_key_set: false, headers_set: false },
    { id: 'vieux', preset: 'custom', base_url: 'https://old.test/v1', api_key_set: true, headers_set: false, api_key_unreadable: true },
  ],
  roles: { investigate: { provider: 'zai', model: 'glm', fallback: null, provider_routing: { order: ['a'] } }, extract: { provider: 'local', model: 'qwen' } },
  redact: { enabled: true, patterns: ['x'] },
  log_prompts: { enabled: false, retention_days: 7 },
};

describe('assert_secret_masked', () => {
  test('rendu : aucune clé en clair, champ en écriture seule sans valeur, indice « secret enregistré »', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(200, llmSettings) });
    const html = await view(ModelsSettingsView);
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain('zz_test_LEAK');
    const keyInputs = [...html.matchAll(/<input[^>]*id="provider-key-\d+"[^>]*>/g)].map((m) => m[0]);
    expect(keyInputs).toHaveLength(3);
    for (const input of keyInputs) {
      expect(input).toContain('type="password"');
      expect(input).toContain('autocomplete="new-password"');
      expect(input).not.toMatch(/\svalue="[^"]+"/);
    }
    expect(html).toContain(en.settings.secret.set);
    expect(html).toContain(en.settings.secret.unset);
    expect(html).toContain(en.settings.secret.unreadable);
  });

  test('l’état de l’écran ne garde jamais la clé reçue par erreur du serveur', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(200, llmSettings) });
    const settings = useLlmSettings();
    await settings.load();
    expect(JSON.stringify(settings.providers.value)).not.toContain(SECRET);
    expect(JSON.stringify(settings.providers.value)).not.toContain('zz_test_LEAK');
    expect(settings.providers.value[0]).toMatchObject({ apiKeySet: true, newApiKey: '' });
    expect(settings.providers.value[2]).toMatchObject({ apiKeyUnreadable: true });
  });

  test('enregistrer : la clé saisie part une fois, le champ est vidé avant la réponse, les autres fournisseurs gardent leur clé', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const calls = installFakeServer({
      'GET /api/settings/llm': () => json(200, llmSettings),
      'PUT /api/settings/llm': async () => {
        await gate;
        return json(200, { ...llmSettings, providers: llmSettings.providers.map(({ api_key: _key, headers: _headers, ...rest }) => rest) });
      },
    });
    const settings = useLlmSettings();
    await settings.load();
    settings.providers.value[1]!.newApiKey = 'zz_test_nouvelle_cle';
    const pending = settings.save();
    // Pendant l'envoi, la clé a déjà quitté le champ.
    expect(settings.providers.value[1]?.newApiKey).toBe('');
    release();
    expect(await pending).toBe(true);
    const put = calls.find((c) => c.method === 'PUT');
    const sent = put?.body as { providers: { id: string; api_key?: string }[]; roles: Record<string, unknown>; redact: unknown; log_prompts: unknown };
    expect(sent.providers.map((p) => [p.id, p.api_key])).toEqual([['zai', undefined], ['local', 'zz_test_nouvelle_cle'], ['vieux', undefined]]);
    // Les réglages que l'écran ne modifie pas (repli, routage, masquage, journal des prompts) sont renvoyés tels quels.
    expect(sent.roles).toMatchObject({ investigate: { provider: 'zai', model: 'glm', fallback: null, provider_routing: { order: ['a'] } }, extract: { provider: 'local', model: 'qwen' } });
    expect(sent.redact).toEqual({ enabled: true, patterns: ['x'] });
    expect(sent.log_prompts).toEqual({ enabled: false, retention_days: 7 });
    expect(JSON.stringify(settings.providers.value)).not.toContain('zz_test_nouvelle_cle');
    expect(settings.saved.value).toBe(true);
  });

  test('le champ ne contient jamais de valeur rendue même après saisie puis envoi', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(200, llmSettings), 'PUT /api/settings/llm': () => json(200, llmSettings) });
    const settings = useLlmSettings();
    await settings.load();
    settings.providers.value[0]!.newApiKey = 'zz_test_saisie';
    await settings.save();
    expect(settings.providers.value[0]?.newApiKey).toBe('');
  });
});

describe('Réglages > Modèles IA', () => {
  test('fournisseurs, rôle par modèle, bouton Tester, Enregistrer', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(200, llmSettings) });
    const html = await view(ModelsSettingsView);
    expect(html).toContain(en.settings.models.title);
    expect((html.match(/data-testid="provider"/g) ?? []).length).toBe(3);
    expect((html.match(/data-testid="role-row"/g) ?? []).length).toBe(4);
    expect(html).toContain('value="https://api.z.test/v1"');
    expect(html).toContain(`>${en.settings.test}</button>`);
    expect(html).toContain(en.settings.models.rolesIntro);
  });

  test('statut « modèle validé » en lecture seule (15 §11) : un modèle jamais mesuré par le banc est « non validé »', async () => {
    const validated_models = [
      { model_id: 'glm', date: '2026-09-30', status: 'validated', level: 'N2' },
      { model_id: 'zz-mesure-ko', date: '2026-09-30', status: 'not_validated', level: 'N2' },
    ];
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(200, { ...llmSettings, validated_models }) });
    const html = await view(ModelsSettingsView);
    const badges = [...html.matchAll(/<p[^>]*data-testid="model-validation"[^>]*>([^<]*)<\/p>/g)].map((m) => m[1]?.trim());
    // investigate → glm (validé le 30/09), extract → qwen (jamais mesuré) ; repair et agent sans modèle : aucun badge.
    expect(badges).toEqual([en.settings.models.validation.validated.replace('{date}', '2026-09-30'), en.settings.models.validation.notValidated]);
    // Sans liste du serveur (route antérieure), tout modèle configuré reste « non validé ».
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(200, llmSettings) });
    const bare = await view(ModelsSettingsView);
    expect((bare.match(/data-testid="model-validation"/g) ?? []).length).toBe(2);
    expect(bare).not.toContain(en.settings.models.validation.validated.replace('{date}', '2026-09-30'));
  });

  test('un non-admin (403) lit un message clair, pas une panne', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(403, { error: { code: 'forbidden', message: 'x' } }) });
    const html = await view(ModelsSettingsView);
    expect(html).toContain('data-testid="settings-forbidden"');
    expect(html).toContain(en.settings.adminOnly);
    expect(html).not.toContain('data-testid="models-form"');
  });

  test('Tester : couple fournisseur × modèle, échec lisible (code stable traduit)', async () => {
    const calls = installFakeServer({
      'GET /api/settings/llm': () => json(200, llmSettings),
      'POST /api/settings/llm/test': () => json(200, { ok: false, tested_at: '2026-10-01T10:00:00Z', error: { code: 'llm_refused', params: {} } }),
    });
    const settings = useLlmSettings();
    await settings.load();
    await settings.test('investigate');
    expect(calls.find((c) => c.path === '/api/settings/llm/test')?.body).toEqual({ provider: 'zai', model: 'glm' });
    const outcome = settings.outcomes.value.investigate;
    expect(outcome).toMatchObject({ state: 'done', ok: false, reason: { code: 'llm_refused' } });
    const html = await view(TestOutcome, { outcome });
    expect(html).toContain('Test failed');
    expect(html).toContain('The model refused the request; no automatic fallback.');
  });
});

describe('TestOutcome', () => {
  test('« non testé » tant qu’il ne l’a pas été, puis la date du dernier test', async () => {
    expect(await view(TestOutcome, {})).toContain(en.settings.notTested);
    expect(await view(TestOutcome, { testedAt: '2026-10-01T10:00:00Z' })).toMatch(/Tested on [^<]*2026/);
  });

  test('en cours, réussi avec IP et pays de sortie, échec réseau', async () => {
    expect(await view(TestOutcome, { outcome: { state: 'running' } })).toContain(en.settings.testing);
    const done = await view(TestOutcome, { outcome: { state: 'done', ok: true, testedAt: '2026-10-01T10:00:00Z', reason: null, detail: { exit_ip: '203.0.113.7', exit_country: 'fr' } } });
    expect(done).toContain('Test passed');
    expect(done).toContain('Exit IP 203.0.113.7, country fr');
    expect(await view(TestOutcome, { outcome: { state: 'failed', messageKey: 'errors.network' } })).toContain(esc(en.errors.network));
  });
});

describe('Réglages > Proxys', () => {
  const proxies = { proxies: [{ id: 'p1', label: 'Datacenter FR', type: 'dc', url: 'http://proxy.test:8080', username_set: true, password_set: true, params: {}, price: {}, tested_at: null }, { id: 'p2', label: 'Résidentiel', type: 'res', url: 'http://res.test:9000', username_set: false, password_set: false, params: {}, price: {}, tested_at: '2026-10-01T10:00:00Z' }] };

  test('liste : type, adresse sans identifiants, « enregistrés », « non testé », texte du résidentiel', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/proxies': () => json(200, proxies) });
    const html = await view(ProxiesSettingsView);
    expect((html.match(/data-testid="proxy-row"/g) ?? []).length).toBe(2);
    expect(html).toContain('http://proxy.test:8080');
    expect(html).toContain(en.settings.proxies.credentialsSet);
    expect(html).toContain(en.settings.notTested);
    expect(html).toMatch(/Tested on [^<]*2026/);
    expect(html).toContain('Residential proxy, billed per GB. Reserved for network reasons (country, connection errors). It is not used after a refusal.');
    expect(html).toMatch(/<input[^>]*id="proxy-password"[^>]*type="password"|<input[^>]*type="password"[^>]*id="proxy-password"/);
  });

  test('admin seul : un 403 donne le message, sans formulaire', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/proxies': () => json(403, { error: { code: 'forbidden', message: 'x' } }) });
    const html = await view(ProxiesSettingsView);
    expect(html).toContain('data-testid="settings-forbidden"');
    expect(html).not.toContain('data-testid="proxy-form"');
  });

  test('Tester un proxy : IP et pays de sortie ; ajouter envoie les identifiants une fois ; retirer relit la liste', async () => {
    let list = proxies;
    const calls = installFakeServer({
      'GET /api/settings/proxies': () => json(200, list),
      'POST /api/settings/proxies': () => json(201, proxies.proxies[0]),
      'DELETE /api/settings/proxies/p1': () => {
        list = { proxies: [proxies.proxies[1]!] };
        return json(204, null);
      },
      'POST /api/settings/proxies/p1/test': () => json(200, { ok: true, tested_at: '2026-10-01T10:00:00Z', exit_ip: '203.0.113.7', exit_country: 'fr' }),
    });
    const settings = useProxies();
    await settings.reload();
    await settings.test('p1');
    expect(settings.outcomes.value.p1).toMatchObject({ state: 'done', ok: true, detail: { exit_ip: '203.0.113.7', exit_country: 'fr' } });
    expect(await settings.create({ label: 'Nouveau', type: 'dc', url: 'http://n.test:1', username: 'u', password: 'zz_test_pw' })).toBe(true);
    expect(calls.find((c) => c.method === 'POST' && c.path === '/api/settings/proxies')?.body).toEqual({ label: 'Nouveau', type: 'dc', url: 'http://n.test:1', username: 'u', password: 'zz_test_pw' });
    expect(await settings.remove('p1')).toBe(true);
    expect(settings.data.value?.proxies.map((p) => p.id)).toEqual(['p2']);
  });
});

describe('Réglages > Extension et sessions', () => {
  test('appareils, domaines connectés, révocation ; aucun cookie affiché', async () => {
    installFakeServer({
      ...sessionRoutes,
      'GET /api/extension/devices': () => json(200, { items: [{ id: 'd1', deviceLabel: 'Chrome du bureau', createdAt: '2026-09-01T10:00:00Z', lastSeenAt: '2026-10-01T09:00:00Z', expiresAt: '2026-12-01T10:00:00Z', revokedAt: null }, { id: 'd2', deviceLabel: null, createdAt: '2026-09-01T10:00:00Z', lastSeenAt: null, expiresAt: '2026-12-01T10:00:00Z', revokedAt: '2026-09-15T10:00:00Z' }] }),
      'GET /api/sites': () => json(200, { items: [{ id: 's1', domain: 'exemple.test', serverUseAllowed: false, hasServerCookies: false, consentedAt: '2026-09-01T10:00:00Z', capturedAt: null, expiresAt: null }] }),
    });
    const html = await view(ExtensionSettingsView);
    expect(html).toContain('Chrome du bureau');
    expect(html).toContain(en.settings.extension.deviceUnnamed);
    expect(html).toContain(en.settings.extension.revoked);
    expect((html.match(/data-testid="device-row"/g) ?? []).length).toBe(2);
    expect(html).toContain('exemple.test');
    expect(html).toContain(en.settings.extension.modeBrowser);
    expect(html).toMatch(/<input[^>]*id="pairing-password"[^>]*type="password"|<input[^>]*type="password"[^>]*id="pairing-password"/);
    expect(html).not.toMatch(/cookie/i);
  });

  test('code d’appairage : mot de passe actuel envoyé une fois, code affiché une fois puis masqué, refus lisible', async () => {
    const calls = installFakeServer({
      'POST /api/extension/pairing-codes': (call) => ((call.body as { currentPassword: string }).currentPassword === 'bon' ? json(201, { code: 'ABCD-1234', expiresAt: '2026-10-01T10:10:00Z' }) : json(403, { error: { code: 'reauth_failed', message: 'x' } })),
    });
    const extension = useExtensionSettings();
    expect(await extension.createPairingCode('mauvais')).toBe(false);
    expect(extension.failure.value).toBe('errors.reauth_failed');
    expect(extension.pairing.value).toBeNull();
    expect(await extension.createPairingCode('bon')).toBe(true);
    expect(extension.pairing.value).toEqual({ code: 'ABCD-1234', expiresAt: '2026-10-01T10:10:00Z' });
    extension.dismissPairing();
    expect(extension.pairing.value).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test('code d’appairage : un mot de passe vide est refusé en local, sans aucune requête (F-20261001-UX01)', async () => {
    const calls = installFakeServer({ 'POST /api/extension/pairing-codes': () => json(400, { error: { code: 'invalid_request', message: 'x' } }) });
    const extension = useExtensionSettings();
    expect(await extension.createPairingCode('')).toBe(false);
    expect(extension.failure.value).toBe('settings.extension.passwordRequired');
    expect(extension.pairing.value).toBeNull();
    expect(calls).toHaveLength(0);
    expect(extension.pairingBusy.value).toBe(false);
  });

  test('code d’appairage : un second envoi à vide retire puis remet le message (role="alert" réannoncé), le champ est marqué invalide', async () => {
    installFakeServer({ 'POST /api/extension/pairing-codes': () => json(403, { error: { code: 'reauth_failed', message: 'x' } }) });
    const extension = useExtensionSettings();
    const seen: (string | null)[] = [];
    // Observateur au rythme du rendu (flush « pre ») : il voit ce que voit le DOM, pas les écritures d'un même tick.
    watch(extension.failure, (value) => seen.push(value));
    expect(await extension.createPairingCode('')).toBe(false);
    await nextTick();
    expect(await extension.createPairingCode('')).toBe(false);
    await nextTick();
    expect(seen).toEqual(['settings.extension.passwordRequired', null, 'settings.extension.passwordRequired']);
    expect(extension.passwordInvalid.value).toBe(true);
    expect(await extension.createPairingCode('mauvais')).toBe(false);
    expect(extension.passwordInvalid.value).toBe(true);
    extension.dismissPairing();
    expect(await extension.revokeDevice('zz')).toBe(false);
    expect(extension.passwordInvalid.value).toBe(false);
  });

  test('code d’appairage : un mot de passe fait d’espaces part au serveur tel quel (un mot de passe peut contenir des espaces)', async () => {
    const calls = installFakeServer({ 'POST /api/extension/pairing-codes': () => json(403, { error: { code: 'reauth_failed', message: 'x' } }) });
    const extension = useExtensionSettings();
    expect(await extension.createPairingCode('   ')).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({ currentPassword: '   ' });
    expect(extension.failure.value).toBe('errors.reauth_failed');
  });

  test('code d’appairage : une validation du serveur (invalid_request) s’affiche comme une saisie à corriger, pas comme une erreur générique', async () => {
    installFakeServer({ 'POST /api/extension/pairing-codes': () => json(400, { error: { code: 'invalid_request', message: 'x' } }) });
    const extension = useExtensionSettings();
    expect(await extension.createPairingCode('x')).toBe(false);
    expect(extension.failure.value).toBe('errors.invalid_request');
  });

  test('révoquer un appareil et déconnecter un domaine relisent les listes', async () => {
    let devices = [{ id: 'd1', deviceLabel: 'A', createdAt: '2026-09-01T10:00:00Z', lastSeenAt: null, expiresAt: '2026-12-01T10:00:00Z', revokedAt: null }];
    const calls = installFakeServer({
      'GET /api/extension/devices': () => json(200, { items: devices }),
      'GET /api/sites': () => json(200, { items: [] }),
      'DELETE /api/extension/devices/d1': () => {
        devices = [];
        return json(204, null);
      },
      'DELETE /api/sites/s1': () => json(204, null),
    });
    const extension = useExtensionSettings();
    await extension.devices.reload();
    expect(await extension.revokeDevice('d1')).toBe(true);
    expect(extension.devices.data.value?.items).toEqual([]);
    expect(await extension.disconnectSite('s1')).toBe(true);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
  });
});

describe('Réglages > Alertes', () => {
  const smtp = { host: 'smtp.test', port: 587, security: 'starttls', from: 'robot@exemple.test', username_set: true, password_set: true, tested_at: null };
  const hooks = { subscriptions: [{ id: 'w1', url: 'https://hooks.test/in', events: ['run.failed', 'items.new'], api_slug: null, status: 'active', tested_at: null, created_at: '2026-10-01T10:00:00Z' }] };

  test('SMTP et webhooks : « non testé » tant que le canal ne l’a pas été, événements en clair, mot de passe en écriture seule', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/smtp': () => json(200, smtp), 'GET /api/webhook-subscriptions': () => json(200, hooks) });
    const html = await view(AlertsSettingsView);
    expect(html).toContain('value="smtp.test"');
    expect(html).toContain('value="robot@exemple.test"');
    expect(html).toContain(en.settings.secret.set);
    expect((html.match(new RegExp(en.settings.notTested, 'g')) ?? []).length).toBe(2);
    expect(html).toContain('Run failed, New items');
    expect(html).toContain('https://hooks.test/in');
    expect(html).toMatch(/<input[^>]*id="smtp-password"[^>]*type="password"|<input[^>]*type="password"[^>]*id="smtp-password"/);
    expect(html).not.toMatch(/id="smtp-password"[^>]*value="[^"]+"/);
  });

  test('SMTP non configuré (null) : message vide, formulaire utilisable', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/smtp': () => json(200, null), 'GET /api/webhook-subscriptions': () => json(200, { subscriptions: [] }) });
    const html = await view(AlertsSettingsView);
    expect(html).toContain(en.settings.alerts.smtpEmpty);
    expect(html).toContain(en.settings.alerts.webhooksEmpty);
  });

  test('SMTP : mot de passe envoyé seulement s’il est saisi ; Tester vise l’adresse donnée', async () => {
    const calls = installFakeServer({
      'GET /api/settings/smtp': () => json(200, smtp),
      'PUT /api/settings/smtp': () => json(200, smtp),
      'POST /api/settings/smtp/test': () => json(200, { ok: true, tested_at: '2026-10-01T10:00:00Z' }),
    });
    const settings = useSmtp();
    await settings.reload();
    await settings.save({ host: 'smtp.test', port: 587, security: 'starttls', from: 'robot@exemple.test' });
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ host: 'smtp.test', port: 587, security: 'starttls', from: 'robot@exemple.test' });
    await settings.test('moi@exemple.test');
    expect(calls.find((c) => c.path === '/api/settings/smtp/test')?.body).toEqual({ to: 'moi@exemple.test' });
    expect(settings.outcomes.value.smtp).toMatchObject({ state: 'done', ok: true });
  });

  test('webhook : le secret de signature n’apparaît qu’à la création et disparaît quand on l’a copié', async () => {
    const calls = installFakeServer({
      'GET /api/webhook-subscriptions': () => json(200, hooks),
      'POST /api/webhook-subscriptions': () => json(201, { ...hooks.subscriptions[0], secret: 'whsec_zz_test_secret' }),
      'POST /api/webhook-subscriptions/w1/test': () => json(200, { ok: false, tested_at: '2026-10-01T10:00:00Z', error: { code: 'unavailable', params: {} } }),
    });
    const webhooks = useWebhooks();
    await webhooks.reload();
    expect(await webhooks.create({ url: 'https://hooks.test/in', events: ['run.failed'], api_slug: null })).toBe(true);
    expect(webhooks.createdSecret.value).toBe('whsec_zz_test_secret');
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    expect(JSON.stringify(webhooks.data.value)).not.toContain('whsec_zz_test_secret');
    webhooks.dismissSecret();
    expect(webhooks.createdSecret.value).toBeNull();
    await webhooks.test('w1');
    expect(webhooks.outcomes.value.w1).toMatchObject({ state: 'done', ok: false, reason: { code: 'unavailable' } });
  });
});

describe('Diagnostic local', () => {
  // Forme réelle de `GET /api/version` (apps/server/src/routes/system.ts, 16 §3) : typée par le schéma généré, pour qu'un
  // changement du contrat casse ce test au typage au lieu de le laisser passer sur une forme périmée.
  const version: components['schemas']['Version'] = { server: '1.0.0', schema: 12, min_extension: '0.1.0', mcp_spec: '2026-07-28' };

  test('liste blanche : versions, disponibilité, langue de la console ; jamais de clé, de cookie ni d’identité', async () => {
    const api = buildApi({ baseUrl: 'http://console.test', fetch: async (request) => (new URL(request.url).pathname === '/api/version' ? json(200, { ...version, db_password: 'zz_test_pw', token: 'zz_test_token' }) : json(200, { status: 'ready', db: 'ok', secret: 'zz_test_secret' })) });
    const diagnostic = await collectDiagnostic(api, 'fr', new Date('2026-10-01T10:00:00Z'));
    expect(diagnostic).toEqual({ generated_at: '2026-10-01T10:00:00.000Z', console_locale: 'fr', instance: { server: '1.0.0', schema: 12, min_extension: '0.1.0', mcp_spec: '2026-07-28' }, readiness: { ok: true } });
    expect(JSON.stringify(diagnostic)).not.toMatch(/zz_test|password|token|secret|cookie|email/i);
  });

  test('ancienne forme {version, schema_version} : aucun champ n’est inventé, tout reste à null', async () => {
    const api = buildApi({ baseUrl: 'http://console.test', fetch: async (request) => (new URL(request.url).pathname === '/api/version' ? json(200, { version: '1.0.0', schema_version: 12 }) : json(200, { status: 'ready' })) });
    const diagnostic = await collectDiagnostic(api, 'fr', new Date('2026-10-01T10:00:00Z'));
    expect(diagnostic.instance).toEqual({ server: null, schema: null, min_extension: null, mcp_spec: null });
  });

  test('une route qui échoue laisse le champ à null : le diagnostic reste exportable', async () => {
    const api = buildApi({ baseUrl: 'http://console.test', fetch: async () => { throw new TypeError('fetch failed'); } });
    expect(await collectDiagnostic(api, 'en', new Date('2026-10-01T10:00:00Z'))).toEqual({ generated_at: '2026-10-01T10:00:00.000Z', console_locale: 'en', instance: { server: null, schema: null, min_extension: null, mcp_spec: null }, readiness: { ok: null } });
  });
});

describe('Réglages > Modèles IA : préréglages de fournisseurs (UX-01)', () => {
  test('Anthropic est proposé, libellé « Anthropic », avec les autres fournisseurs compatibles OpenAI', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(200, llmSettings) });
    const html = await view(ModelsSettingsView);
    for (const preset of ['anthropic', 'gemini', 'mistral', 'groq']) {
      expect(html).toContain(`<option value="${preset}">${en.settings.models.presets[preset as 'anthropic']}</option>`);
    }
    expect(en.settings.models.presets.anthropic).toBe('Anthropic');
  });

  test('choisir Anthropic pré-remplit l’URL de base ; une URL saisie à la main n’est pas écrasée', async () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(200, llmSettings) });
    const settings = useLlmSettings();
    settings.addProvider();
    const draft = (): NonNullable<(typeof settings.providers.value)[number]> => settings.providers.value[0] as never;
    settings.setPreset(0, 'anthropic');
    expect(draft().preset).toBe('anthropic');
    expect(draft().base_url).toBe('https://api.anthropic.com/v1');
    settings.setPreset(0, 'mistral');
    expect(draft().base_url).toBe('https://api.mistral.ai/v1');
    settings.providers.value[0]!.base_url = 'https://proxy.interne.test/v1';
    settings.setPreset(0, 'groq');
    expect(draft().base_url).toBe('https://proxy.interne.test/v1');
    settings.setPreset(0, 'custom');
    expect(draft().base_url).toBe('https://proxy.interne.test/v1');
  });

  test('Z.ai, DeepSeek et Qwen pré-remplissent aussi leur URL de base', () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(200, llmSettings) });
    const settings = useLlmSettings();
    settings.addProvider();
    const draft = (): NonNullable<(typeof settings.providers.value)[number]> => settings.providers.value[0] as never;
    settings.setPreset(0, 'zai');
    expect(draft().base_url).toBe('https://api.z.ai/api/paas/v4');
    settings.setPreset(0, 'deepseek');
    expect(draft().base_url).toBe('https://api.deepseek.com/v1');
    settings.setPreset(0, 'qwen');
    expect(draft().base_url).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
  });

  test('passer d’un préréglage pré-rempli à ollama, vllm ou custom vide l’URL de l’ancien fournisseur', () => {
    installFakeServer({ ...sessionRoutes, 'GET /api/settings/llm': () => json(200, llmSettings) });
    const settings = useLlmSettings();
    settings.addProvider();
    const draft = (): NonNullable<(typeof settings.providers.value)[number]> => settings.providers.value[0] as never;
    for (const target of ['ollama', 'vllm', 'custom'] as const) {
      settings.setPreset(0, 'anthropic');
      expect(draft().base_url).toBe('https://api.anthropic.com/v1');
      settings.setPreset(0, target);
      expect(draft().preset).toBe(target);
      expect(draft().base_url).toBe('');
    }
  });

  test('la liste déroulante couvre tout l’enum LlmPreset du contrat OpenAPI', () => {
    const spec = readFileSync(new URL('../../../../../packages/client/openapi/openapi.yaml', import.meta.url), 'utf8');
    const line = /\n {4}LlmPreset:\n {6}type: string\n {6}enum: \[([^\]]+)\]/.exec(spec);
    expect(line).not.toBeNull();
    const contract = (line?.[1] ?? '').split(',').map((value) => value.trim());
    expect([...LLM_PRESETS].sort()).toEqual([...contract].sort());
  });
});
