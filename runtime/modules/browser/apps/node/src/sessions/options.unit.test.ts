// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 1.3 (04 § 3, 04f § 1 et § 2) : options d'une session shared traduites en options de contexte Playwright, validées
// par le nœud (défense en profondeur derrière la passerelle) ; protocole Playwright natif seulement, jamais CDP.
import { describe, expect, test } from 'vitest';
import { InvalidSessionOptionError, SHARED_CONTEXT_DEFAULTS, sharedContextOptions } from './options.js';
import { ProtocolNotServedError, assertProtocolServed, connectUrlsFor, servedProtocols } from './protocols.js';

function invalidFields(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidSessionOptionError);
    const typed = error as InvalidSessionOptionError;
    expect(typed.code).toBe('invalid_option');
    return typed.details.map((d) => d.field);
  }
  throw new Error('InvalidSessionOptionError attendue');
}

describe('options de contexte d’une session shared (04 § 3)', () => {
  test('défauts de l’instance : 1280x720, en-US, UTC, thème clair, téléchargements refusés', () => {
    expect(SHARED_CONTEXT_DEFAULTS).toEqual({ viewport: { width: 1280, height: 720 }, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', acceptDownloads: false });
    expect(sharedContextOptions({})).toEqual(SHARED_CONTEXT_DEFAULTS);
  });

  test('chaque option posée passe au contexte ; la géolocalisation accorde la seule permission geolocation', () => {
    const options = sharedContextOptions({
      viewport: { width: 1024, height: 600 },
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      userAgent: 'ZZ-Test-Agent/1.0',
      extraHTTPHeaders: { 'X-ZZ-Test': 'oui' },
      geolocation: { latitude: 48.85, longitude: 2.35, accuracy: 10 },
      colorScheme: 'dark',
      acceptDownloads: true,
    });
    expect(options).toEqual({
      viewport: { width: 1024, height: 600 },
      locale: 'fr-FR',
      timezoneId: 'Europe/Paris',
      userAgent: 'ZZ-Test-Agent/1.0',
      extraHTTPHeaders: { 'X-ZZ-Test': 'oui' },
      geolocation: { latitude: 48.85, longitude: 2.35, accuracy: 10 },
      permissions: ['geolocation'],
      colorScheme: 'dark',
      acceptDownloads: true,
    });
  });

  test('egress de la session (tâche 1.5) : proxy du contexte posé par le nœud, jamais par le client', () => {
    expect(sharedContextOptions({}, { egressProxyUrl: 'http://127.0.0.1:40001' }).proxy).toEqual({ server: 'http://127.0.0.1:40001', bypass: '<-loopback>' });
    expect(() => sharedContextOptions({}, { egressProxyUrl: 'http://10.0.0.1:3128' })).toThrow(RangeError);
    // Un champ `proxy` venu du client est un champ inconnu : refusé, jamais transmis.
    expect(invalidFields(() => sharedContextOptions({ proxy: { server: 'http://evil.test:1' } } as never))).toEqual(['proxy']);
  });

  test('valeurs invalides : 422 invalid_option, chaque champ nommé', () => {
    expect(
      invalidFields(() =>
        sharedContextOptions({
          viewport: { width: 0, height: 1.5 },
          locale: 'pas une langue !',
          timezoneId: 'Mars/Olympus',
          userAgent: 'a\nb',
          extraHTTPHeaders: { 'X Bad': 'v', Ok: 'line\r\nbreak' },
          geolocation: { latitude: 91, longitude: 0 },
          colorScheme: 'sepia' as never,
          acceptDownloads: 'yes' as never,
        }),
      ),
    ).toEqual(['viewport', 'locale', 'timezoneId', 'userAgent', 'extraHTTPHeaders', 'extraHTTPHeaders', 'geolocation', 'colorScheme', 'acceptDownloads']);
    expect(invalidFields(() => sharedContextOptions({ userAgent: 'x'.repeat(513) }))).toEqual(['userAgent']);
    expect(invalidFields(() => sharedContextOptions({ viewport: { width: 99_999, height: 720 } }))).toEqual(['viewport']);
  });

  test('en-têtes de transport et de proxy refusés (Host, Proxy-Authorization, Connection…)', () => {
    for (const name of ['Host', 'proxy-authorization', 'Proxy-Connection', 'Connection', 'Content-Length', 'Transfer-Encoding', 'Upgrade', 'TE', 'Keep-Alive']) {
      expect(invalidFields(() => sharedContextOptions({ extraHTTPHeaders: { [name]: 'x' } }))).toEqual(['extraHTTPHeaders']);
    }
  });

  test('storageState : objet seulement ; un chemin de fichier (lu par Playwright sur le nœud) est refusé', () => {
    const state = { cookies: [{ name: 'a', value: 'b', domain: 'zz-test.invalid', path: '/' }], origins: [{ origin: 'https://zz-test.invalid', localStorage: [{ name: 'k', value: 'v' }] }] };
    expect(sharedContextOptions({ storageState: state }).storageState).toEqual(state);
    expect(invalidFields(() => sharedContextOptions({ storageState: '/etc/passwd' as never }))).toEqual(['storageState']);
    expect(invalidFields(() => sharedContextOptions({ storageState: { cookies: 'x', origins: [] } as never }))).toEqual(['storageState']);
  });

  test('options réservées aux sessions dedicated (profile, launchArgs) : refusées ici, la bascule de type appartient à la création (tâche 1.4)', () => {
    expect(invalidFields(() => sharedContextOptions({ profile: { id: 'p1', mode: 'read' } }))).toEqual(['profile']);
    expect(invalidFields(() => sharedContextOptions({ launchArgs: ['mute-audio'] }))).toEqual(['launchArgs']);
  });
});

describe('shared_no_cdp : protocole Playwright natif seulement (04f § 1 et § 2, CDC v1.2)', () => {
  test('shared : Playwright seulement ; dedicated : Playwright et CDP ; BiDi réservé', () => {
    expect(servedProtocols('shared')).toEqual({ playwright: true, cdp: false, bidi: false });
    expect(servedProtocols('dedicated')).toEqual({ playwright: true, cdp: true, bidi: false });
  });

  test('connectUrls : cdp nul pour shared, présent pour dedicated, bidi toujours nul', () => {
    const urls = { playwright: 'wss://b.test/v1/sessions/s1/playwright?token=t', cdp: 'wss://b.test/v1/sessions/s1/cdp?token=t' };
    expect(connectUrlsFor('shared', urls)).toEqual({ playwright: urls.playwright, cdp: null, bidi: null });
    expect(connectUrlsFor('dedicated', urls)).toEqual({ playwright: urls.playwright, cdp: urls.cdp, bidi: null });
  });

  test('CDP demandé sur une session shared : 409 protocol_not_served avec la phrase d’action', () => {
    expect(() => assertProtocolServed('shared', 'playwright')).not.toThrow();
    expect(() => assertProtocolServed('dedicated', 'cdp')).not.toThrow();
    let error: unknown;
    try {
      assertProtocolServed('shared', 'cdp');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProtocolNotServedError);
    expect(error).toMatchObject({ code: 'protocol_not_served', status: 409, retryable: false, what_to_do: 'Crée la session en type `dedicated` pour la piloter en CDP.' });
    expect(() => assertProtocolServed('shared', 'bidi')).toThrow(ProtocolNotServedError);
  });
});
