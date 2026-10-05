// SPDX-License-Identifier: AGPL-3.0-only
// assert_optional_hosts (07 § 2, § 4), source : aucun <all_urls> ni hôte statique ; permissions fixes seulement.
// Le manifeste construit et celui chargé dans Chromium sont vérifiés par e2e/extension.e2e.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MANIFEST } from '../manifest.ts';

const SRC = new URL('..', import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Code sans commentaires (les commentaires citent l'API qu'ils décrivent). */
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/<!--[\s\S]*?-->/g, '');

describe('assert_optional_hosts', () => {
  test('host_permissions vide, hôtes en optional_host_permissions, permissions fixes de 07 § 4', () => {
    expect(MANIFEST.host_permissions).toEqual([]);
    expect(JSON.stringify(MANIFEST)).not.toContain('<all_urls>');
    expect(MANIFEST.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    expect([...MANIFEST.permissions].sort()).toEqual(['alarms', 'cookies', 'debugger', 'scripting', 'storage', 'tabGroups', 'tabs']);
    expect(MANIFEST).not.toHaveProperty('content_scripts');
  });
});

describe('assert_consent_before_capture (contrôle statique)', () => {
  const sources = files(SRC).filter((f) => /\.(ts|html)$/.test(f) && !f.endsWith('.test.ts'));

  test('l’API cookies n’est appelée qu’à un seul endroit : le câblage du service worker vers le noyau', () => {
    const users = sources.filter((f) => /\b(browser|chrome)\.cookies\b/.test(code(f)));
    expect(users.map((f) => f.slice(SRC.length))).toEqual(['entrypoints/background.ts']);
    expect(code(join(SRC, 'entrypoints/background.ts')).match(/\b(browser|chrome)\.cookies\.\w+/g)).toEqual(['browser.cookies.getAll', 'browser.cookies.onChanged']); // onChanged : domaine et sens du changement, jamais la valeur (B2)
  });

  test('dans le noyau, `cookies.getAll` n’est appelé que par #readCookies, lui-même appelé par capture() après ses contrôles', () => {
    const core = code(join(SRC, 'core/controller.ts'));
    expect(core.match(/cookies\.getAll\(/g)).toHaveLength(1);
    expect(core.match(/#readCookies\(/g)).toHaveLength(2); // définition + un seul appel
    const capture = core.slice(core.indexOf('async capture('), core.indexOf('async #readCookies('));
    const read = capture.indexOf('#readCookies(');
    for (const guard of ["'consent_required'", "consent.mode !== 'server'", 'consent.recipient !== pairing.origin', 'permissions.contains']) {
      expect(capture.indexOf(guard), guard).toBeGreaterThan(-1);
      expect(capture.indexOf(guard), guard).toBeLessThan(read);
    }
  });

  test('aucune exécution de code distant ni d’évaluation dans le paquet', () => {
    for (const f of sources) expect(code(f), f).not.toMatch(/\beval\(|new Function\(|<all_urls>/);
  });
});
