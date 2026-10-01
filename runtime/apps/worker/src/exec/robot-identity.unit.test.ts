// SPDX-License-Identifier: AGPL-3.0-only
// Identité du robot par run (1.11, 17 §5, décision du 2026-10-01) : par défaut le User-Agent réel du moteur, sans jeton ni
// From ; avec `identify_instance`, le jeton de l'instance et From (adresse électronique). Un contact absent alors que
// l'identification est activée est journalisé (avertissement, une fois par exécuteur) au lieu de passer en silence ; le
// contact reste exigé avant la première enquête (`requireInstanceContact`, repris par 2.1).
import { InstanceContactError } from '@runtime/core/access';
import { describe, expect, test, vi } from 'vitest';
import { installedEngineIdentity } from '../browser/engine-identity.js';
import { robotIdentity } from './robot-identity.js';

const ENGINE = { version: '153.0.8010.12', platform: 'linux' };
const ENGINE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

describe('robotIdentity', () => {
  test('identify_instance désactivé (défaut) : la chaîne du moteur seule, ni jeton ni From, aucun avertissement', async () => {
    const warn = vi.fn();
    const identity = robotIdentity({ version: '1.2.3', engine: () => ENGINE, instanceContact: async () => 'ops@zz-test.example', warn });
    expect(await identity()).toEqual({ userAgent: ENGINE_UA, from: null });
    const off = robotIdentity({ version: '1.2.3', engine: () => ENGINE, instanceContact: async () => null, identifyInstance: async () => false, warn });
    expect(await off()).toEqual({ userAgent: ENGINE_UA, from: null });
    expect(warn).not.toHaveBeenCalled();
  });

  test('identify_instance activé : jeton compatible; Scrapyomama/<version>; +<contact> et From (adresse électronique)', async () => {
    const warn = vi.fn();
    const identity = robotIdentity({ version: '1.2.3', engine: () => ENGINE, instanceContact: async () => 'ops@zz-test.example', identifyInstance: async () => true, warn });
    expect(await identity()).toEqual({ userAgent: `${ENGINE_UA} (compatible; Scrapyomama/1.2.3; +mailto:ops@zz-test.example)`, from: 'ops@zz-test.example' });
    const byUrl = robotIdentity({ version: '1.2.3', engine: () => ENGINE, instanceContact: async () => 'https://ops.zz-test.example/robot', identifyInstance: async () => true, warn });
    expect(await byUrl()).toEqual({ userAgent: `${ENGINE_UA} (compatible; Scrapyomama/1.2.3; +https://ops.zz-test.example/robot)`, from: null });
    expect(warn).not.toHaveBeenCalled();
  });

  test('le réglage est relu à chaque run', async () => {
    let on = false;
    const identity = robotIdentity({ version: '1.2.3', engine: () => ENGINE, instanceContact: async () => 'ops@zz-test.example', identifyInstance: async () => on, warn: vi.fn() });
    expect((await identity()).userAgent).toBe(ENGINE_UA);
    on = true;
    expect((await identity()).userAgent).toContain('Scrapyomama/1.2.3');
    on = false;
    expect((await identity()).userAgent).toBe(ENGINE_UA);
  });

  test('identification activée sans contact : jeton sans contact et avertissement instance_contact_missing (une seule fois)', async () => {
    const warn = vi.fn();
    const identity = robotIdentity({ version: '1.2.3', engine: () => ENGINE, instanceContact: async () => null, identifyInstance: async () => true, warn });
    expect(await identity()).toEqual({ userAgent: `${ENGINE_UA} (compatible; Scrapyomama/1.2.3)`, from: null });
    await identity();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('instance_contact_missing');
    const none = vi.fn();
    expect((await robotIdentity({ engine: () => ENGINE, identifyInstance: async () => true, warn: none })()).userAgent).toBe(`${ENGINE_UA} (compatible; Scrapyomama/0.0.0)`);
    expect(none).toHaveBeenCalledWith('instance_contact_missing');
  });

  test('contact invalide avec l’identification activée : InstanceContactError (le run est refusé par l’appelant)', async () => {
    const identity = robotIdentity({ version: '1.2.3', engine: () => ENGINE, instanceContact: async () => 'pas un contact', identifyInstance: async () => true, warn: vi.fn() });
    await expect(identity()).rejects.toBeInstanceOf(InstanceContactError);
  });

  test('moteur par défaut : le Chromium épinglé par le Playwright installé, plateforme réelle, sans HeadlessChrome', async () => {
    const engine = installedEngineIdentity();
    expect(engine.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    expect(engine.platform).toBe(process.platform);
    const { userAgent } = await robotIdentity({ warn: vi.fn() })();
    expect(userAgent).toContain(`Chrome/${engine.version.split('.')[0]}.0.0.0 Safari/537.36`);
    expect(userAgent).not.toMatch(/Headless|Scrapyomama/);
  });
});
