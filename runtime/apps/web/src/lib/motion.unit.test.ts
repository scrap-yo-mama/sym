// SPDX-License-Identifier: AGPL-3.0-only
// Réglage Animations (20 § 4.3) : Système ou Réduites, mémorisé dans ce navigateur et posé sur <html> avant le premier rendu.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { applyMotion, isMotion, MOTION_STORAGE_KEY, readStoredMotion, storeMotion } from './motion';

describe('réglage Animations', () => {
  test('valeur mémorisée invalide ou stockage indisponible : Système', () => {
    expect(readStoredMotion({ getItem: () => 'turbo' })).toBe('system');
    expect(readStoredMotion({ getItem: () => 'reduced' })).toBe('reduced');
    expect(
      readStoredMotion({
        getItem: () => {
          throw new Error('SecurityError');
        },
      }),
    ).toBe('system');
    expect(isMotion(null)).toBe(false);
  });

  test('storeMotion mémorise sous la clé lue par public/theme-init.js ; applyMotion pose et retire data-motion', () => {
    const written: Record<string, string> = {};
    storeMotion('reduced', { setItem: (key, value) => void (written[key] = value) });
    expect(written).toEqual({ [MOTION_STORAGE_KEY]: 'reduced' });
    const attributes = new Map<string, string>();
    const root = { setAttribute: (name: string, value: string) => attributes.set(name, value), removeAttribute: (name: string) => attributes.delete(name) } as unknown as HTMLElement;
    applyMotion('reduced', root);
    expect(attributes.get('data-motion')).toBe('reduced');
    applyMotion('system', root);
    expect(attributes.has('data-motion')).toBe(false);
    const init = readFileSync(new URL('../../public/theme-init.js', import.meta.url), 'utf8');
    expect(init).toContain(`localStorage.getItem('${MOTION_STORAGE_KEY}') === 'reduced'`);
    expect(init).toContain("setAttribute('data-motion', 'reduced')");
  });
});
