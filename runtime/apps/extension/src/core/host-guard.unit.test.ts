// SPDX-License-Identifier: AGPL-3.0-only
// Garde des domaines (07 § 5, INV10) : parité exacte avec la règle de l'instance (`checkSiteDomain`), pour que
// l'extension et la passerelle refusent les mêmes cibles ; motifs d'hôte optionnels par domaine.
import { cookieMatchesDomain as instanceCookieRule } from '@runtime/core';
import { checkSiteDomain } from '@runtime/core/net';
import { describe, expect, test } from 'vitest';
import { checkHost, cookieMatchesDomain, originPatterns, siteDomainOf } from './host-guard.ts';

const VECTORS = [
  'zz-test-shop.example', 'Shop.Example.COM', 'shop.example.com.', 'https://shop.example.com/path?q=1', 'http://shop.example.com:8080/',
  'xn--bcher-kva.example', 'bücher.example', 'localhost', 'LOCALHOST', 'zz.localhost', 'printer.local', 'nas.lan', 'router.home.arpa',
  'metadata.google.internal', 'metadata.goog', 'metadata', 'svc.internal', 'intranet', 'corp', 'build.corp',
  '127.0.0.1', '127.1', '2130706433', '0x7f000001', '0x7f.0.0.1', '0177.0.0.1', '10.0.0.1', '172.16.5.4', '172.32.0.1', '192.168.1.1',
  '169.254.169.254', '100.64.0.1', '100.100.100.200', '0.0.0.0', '255.255.255.255', '224.0.0.1', '198.18.0.1', '192.0.2.10',
  '8.8.8.8', '1.1.1.1', '93.184.216.34', '[::1]', '[fe80::1]', '[2606:4700::1111]', 'http://[::1]/',
  'user:pw@shop.example.com', 'shop.example.com:443', 'shop.example.com/path', '', ' ', '-bad.example', 'a..b.example',
  'under_score.example', 'a'.repeat(64) + '.example', 'ftp://shop.example.com', 'javascript:alert(1)', 'chrome://settings',
];

describe('garde des domaines de l’extension', () => {
  test.each(VECTORS)('parité avec l’instance : %s', (input) => {
    expect(checkHost(input)).toEqual(checkSiteDomain(input));
  });

  test('onglets : seuls les sites http(s) publics peuvent être connectés', () => {
    expect(siteDomainOf('https://Shop.Example.com/cart')).toBe('shop.example.com');
    expect(siteDomainOf('http://zz-test-shop.example:43123/')).toBe('zz-test-shop.example');
    for (const url of [undefined, 'chrome://extensions', 'chrome-extension://abc/popup.html', 'file:///etc/passwd', 'http://localhost:3000/', 'http://192.168.0.1/']) {
      expect(siteDomainOf(url)).toBeNull();
    }
  });

  test('cookies capturés : même règle de domaine que l’instance (un cookie refusé ferait refuser tout l’envoi)', () => {
    const cases: [string, string][] = [
      ['shop.example.com', 'shop.example.com'], ['.shop.example.com', 'shop.example.com'], ['.example.com', 'shop.example.com'],
      ['example.com', 'www.shop.example.com'], ['api.shop.example.com', 'shop.example.com'], ['.com', 'shop.example.com'],
      ['evil.example', 'shop.example.com'], ['Shop.Example.COM.', 'shop.example.com'], ['', 'shop.example.com'], ['xample.com', 'shop.example.com'],
    ];
    for (const [cookie, site] of cases) expect(cookieMatchesDomain(cookie, site), `${cookie} / ${site}`).toBe(instanceCookieRule(cookie, site));
    expect(cookieMatchesDomain('api.shop.example.com', 'shop.example.com')).toBe(false);
  });

  test('permissions optionnelles demandées pour le seul domaine connecté', () => {
    expect(originPatterns('shop.example.com')).toEqual(['https://shop.example.com/*', 'http://shop.example.com/*']);
  });
});
