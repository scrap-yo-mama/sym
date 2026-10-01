// SPDX-License-Identifier: AGPL-3.0-only
// User-Agent du robot par run (1.11, 17 §5), revue : sans contact d'instance, le robot part en `Scrapyomama/<v>` ; ce
// manque est journalisé (avertissement, une fois par exécuteur) au lieu de passer en silence. Le contact reste exigé avant
// la première enquête (`requireInstanceContact`, repris par 2.1).
import { InstanceContactError } from '@runtime/core/access';
import { describe, expect, test, vi } from 'vitest';
import { robotIdentity } from './robot-identity.js';

describe('robotIdentity', () => {
  test('contact posé : User-Agent avec contact, aucun avertissement', async () => {
    const warn = vi.fn();
    const ua = robotIdentity({ version: '1.2.3', instanceContact: async () => 'ops@zz-test.example', warn });
    expect(await ua()).toBe('Scrapyomama/1.2.3 (+mailto:ops@zz-test.example)');
    expect(warn).not.toHaveBeenCalled();
  });

  test('contact absent : User-Agent sans contact et avertissement instance_contact_missing (une seule fois)', async () => {
    const warn = vi.fn();
    const ua = robotIdentity({ version: '1.2.3', instanceContact: async () => null, warn });
    expect(await ua()).toBe('Scrapyomama/1.2.3');
    expect(await ua()).toBe('Scrapyomama/1.2.3');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('instance_contact_missing');
    const none = vi.fn();
    expect(await robotIdentity({ warn: none })()).toBe('Scrapyomama/0.0.0');
    expect(none).toHaveBeenCalledWith('instance_contact_missing');
  });

  test('contact invalide : InstanceContactError (le run est refusé par l’appelant)', async () => {
    const ua = robotIdentity({ version: '1.2.3', instanceContact: async () => 'pas un contact', warn: vi.fn() });
    await expect(ua()).rejects.toBeInstanceOf(InstanceContactError);
  });
});
