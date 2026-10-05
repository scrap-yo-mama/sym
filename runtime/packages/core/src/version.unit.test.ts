// SPDX-License-Identifier: AGPL-3.0-only
// Compatibilité des versions (16 §3, tâche 4.9) : comparaison SemVer, version minimale d'extension.
import { describe, expect, test } from 'vitest';
import { compareSemver, extensionTooOld, MCP_SPEC_VERSION, MIN_EXTENSION_VERSION, parseSemver, resolveBuildInfo } from './version.js';

describe('version', () => {
  test('parseSemver : X.Y.Z et pré-version, rien d’autre', () => {
    expect(parseSemver('0.4.2')).toEqual({ major: 0, minor: 4, patch: 2, pre: [] });
    expect(parseSemver('1.0.0-beta.3')).toEqual({ major: 1, minor: 0, patch: 0, pre: ['beta', '3'] });
    for (const bad of ['', '1', '1.2', 'v1.2.3', '01.2.3', '1.2.3.4', '1.2.3-', '1.2.x', ' 1.2.3']) expect(parseSemver(bad), bad).toBeUndefined();
  });

  test('compareSemver : ordre SemVer 2.0 (la pré-version précède la version)', () => {
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
    expect(compareSemver('0.1.1', '0.1.0')).toBe(1);
    expect(compareSemver('0.2.0', '0.10.0')).toBe(-1);
    expect(compareSemver('1.0.0', '0.99.99')).toBe(1);
    expect(compareSemver('1.0.0-beta.1', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1);
    expect(compareSemver('1.0.0-beta.1', '1.0.0-beta.1')).toBe(0);
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareSemver('1.0.0-beta', '1.0.0-beta.1')).toBe(-1);
    expect(() => compareSemver('x', '1.0.0')).toThrow();
  });

  test('extensionTooOld : sous le minimum, ou version illisible', () => {
    expect(extensionTooOld('0.3.0', '0.4.0')).toBe(true);
    expect(extensionTooOld('0.4.0', '0.4.0')).toBe(false);
    expect(extensionTooOld('0.5.0-beta.1', '0.4.0')).toBe(false);
    expect(extensionTooOld('0.4.0-beta.1', '0.4.0')).toBe(true);
    expect(extensionTooOld('n’importe quoi', '0.4.0')).toBe(true);
    expect(extensionTooOld('0.0.0', MIN_EXTENSION_VERSION)).toBe(false);
  });

  test('extensionTooOld : version absente refusée dès que le minimum dépasse 0.0.0 (sinon un client contourne le refus)', () => {
    expect(extensionTooOld(undefined, '0.4.0')).toBe(true);
    expect(extensionTooOld(undefined, '0.0.1')).toBe(true);
    expect(extensionTooOld(undefined, '0.0.0')).toBe(false);
  });

  test('constantes publiées par GET /api/version', () => {
    expect(parseSemver(MIN_EXTENSION_VERSION)).toBeDefined();
    expect(MCP_SPEC_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// U4.1 (UX-10) : l'instance publie sa vraie version et son commit, jamais le « 0.0.0 » de l'image construite sans argument.
describe('assert_version_not_placeholder : version et commit publiés', () => {
  test('RUNTIME_VERSION posée par la release : elle gagne, avec le commit de RUNTIME_COMMIT', () => {
    expect(resolveBuildInfo({ RUNTIME_VERSION: '1.4.2', RUNTIME_COMMIT: 'abcdef1234567' }, '1.0.0')).toEqual({ version: '1.4.2', commit: 'abcdef1234567' });
  });

  test('image construite sans argument (RUNTIME_VERSION absente, vide ou 0.0.0) : la version du paquet remplace le placeholder', () => {
    for (const env of [{}, { RUNTIME_VERSION: '' }, { RUNTIME_VERSION: '0.0.0' }]) expect(resolveBuildInfo(env, '1.0.0').version, JSON.stringify(env)).toBe('1.0.0');
  });

  test('commit : RUNTIME_COMMIT, sinon RENDER_GIT_COMMIT (Render le pose lui-même) ; absent ou illisible : aucun commit inventé', () => {
    expect(resolveBuildInfo({ RENDER_GIT_COMMIT: '2b5c91c9e0c8d4f7a1b2c3d4e5f60718293a4b5c' }, '1.0.0').commit).toBe('2b5c91c9e0c8d4f7a1b2c3d4e5f60718293a4b5c');
    expect(resolveBuildInfo({ RUNTIME_COMMIT: 'abcdef1', RENDER_GIT_COMMIT: '2b5c91c9' }, '1.0.0').commit).toBe('abcdef1');
    for (const bad of [undefined, '', 'unknown', 'main', '../etc', 'abc']) expect(resolveBuildInfo({ RUNTIME_COMMIT: bad }, '1.0.0').commit, String(bad)).toBeUndefined();
  });

  test('sans version de paquet lisible, le placeholder reste (aucune version inventée)', () => {
    expect(resolveBuildInfo({}, undefined).version).toBe('0.0.0');
  });
});
