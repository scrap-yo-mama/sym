// SPDX-License-Identifier: AGPL-3.0-only
// Masquage en couches 1 et 2 avant tout envoi à un LLM (tâche 2.12, 19 §3, 08 §1, r4 R12, R14, R17) : toujours, que
// `llm.redact` soit actif ou non.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildCatalogDossier, renderCatalogMemory } from '../memory/index.js';
import { profileItems } from '../quality/index.js';
import { judgeUserContent } from '../quality/judge.js';
import { maskPersonal } from './mask.js';
import { FR_CLEAN_CORPUS, FR_PII_CORPUS, type PiiType } from './fr-pii-corpus.testkit.ts';
import { LLM_MASK_TYPES, maskFeedbackForLlm, maskItemsForLlm, maskTextForLlm } from './llm-mask.js';

const SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string', 'x-personal': true }, note: { type: 'string' }, phone: { type: 'string', 'x-personal': 'content' }, price: { type: 'number' } },
};

describe('couches 1 et 2', () => {
  test('couche 1 (schéma) : champs x-personal remplacés par des placeholders indexés, même valeur → même index', () => {
    const out = maskItemsForLlm(
      [
        { name: 'ZZ Jeanne Martin', note: 'ok', phone: 'ZZ-PRIVATE', price: 3 },
        { name: 'ZZ Paul Durand', note: 'ok', phone: null, price: 4 },
        { name: 'ZZ Jeanne Martin', note: 'ok', phone: 'x', price: 5 },
      ],
      SCHEMA,
    );
    expect(out.items[0]).toEqual({ name: '[personal_1]', note: 'ok', phone: '[personal_2]', price: 3 });
    expect(out.items[1]).toMatchObject({ name: '[personal_3]', phone: null });
    expect(out.items[2]).toMatchObject({ name: '[personal_1]' });
    expect(JSON.stringify(out.items)).not.toMatch(/ZZ Jeanne|ZZ Paul|ZZ-PRIVATE/);
  });

  test('couche 2 (motifs) sur les champs libres, sans masquer prix, références, dates', () => {
    const out = maskItemsForLlm([{ name: 'x', note: 'Appeler 06 99 00 12 34 ou zz@example.fr', phone: null, price: 1 }], SCHEMA);
    expect(out.items[0]!['note']).toBe('Appeler [phone] ou [email]');
    for (const clean of FR_CLEAN_CORPUS) expect(maskTextForLlm(clean), clean).toBe(clean);
  });

  test('assert_llm_redaction_fr_corpus — rappel par type mesuré sur le corpus français, publié tel quel', () => {
    expect([...LLM_MASK_TYPES].sort()).toEqual(['card', 'email', 'iban', 'ip', 'nir', 'phone', 'profile_url']);
    const recall: Record<string, { hit: number; total: number }> = {};
    for (const c of FR_PII_CORPUS) {
      const r = (recall[c.type] ??= { hit: 0, total: 0 });
      r.total += 1;
      if (!maskTextForLlm(c.text).includes(c.value)) r.hit += 1;
    }
    const measured = Object.fromEntries(Object.entries(recall).map(([t, r]) => [t, `${r.hit}/${r.total}`]));
    // Table publiée : `| type | rappel |`, une ligne par type.
    const doc = readFileSync(new URL('../../../../docs/qualite/rappel-masquage.md', import.meta.url), 'utf8');
    const published = Object.fromEntries([...doc.matchAll(/^\| `([a-z_]+)` \| (\d+\/\d+) \|/gm)].map((m) => [m[1]!, m[2]!]));
    expect(published).toEqual(measured);
    // Plancher : chaque type masque au moins la moitié du corpus (les numéros à clé fausse, IBAN ou Luhn, ne sont pas masqués).
    for (const [type, r] of Object.entries(recall)) expect(r.hit / r.total, type as PiiType).toBeGreaterThanOrEqual(0.5);
  });
});

describe('assert_profile_no_personal_values', () => {
  test('canaris x-personal et champs libres : 0 occurrence dans profil, mémoire, juge, retours (reflect) et journaux, llm.redact désactivé', () => {
    const canaryName = 'ZZCANARYNAME Dupont';
    const canaryMail = 'zz.canary.mail@example.test';
    const canaryPhone = '06 99 00 98 76';
    const run = Array.from({ length: 6 }, (_, i) => ({ name: canaryName, note: `écrire à ${canaryMail} ou ${canaryPhone}`, phone: canaryPhone, price: i }));
    const leaked = (s: string) => [canaryName, canaryMail, canaryPhone].filter((c) => s.includes(c));

    const profile = profileItems(run, SCHEMA);
    expect(leaked(JSON.stringify(profile))).toEqual([]);

    const dossier = buildCatalogDossier(
      { ownerId: 'o', apiId: 'a', domain: 'a.fr', description: 'x', now: new Date('2026-10-02T00:00:00Z') },
      [
        {
          api_id: 'a', owner_id: 'o', slug: 'zz', domain: 'a.fr', status: 'sain', status_reason: null, session: false, description: 'x', observed_at: '2026-10-01T00:00:00Z', last_healthy_at: '2026-10-01T00:00:00Z',
          versions: [], signature: null, endpoint: null, pagination: null, discarded: [],
          feedback: [{ kind: 'wrong_value', field: 'note', text: `appelle ${canaryPhone}, c'est ${canaryName}`, at: '2026-10-01T00:00:00Z' }],
          step_intents: [], output_schema: SCHEMA, fields: null, sample: run, refusal: null,
        },
      ],
    );
    expect(leaked(renderCatalogMemory(dossier)).filter((c) => c !== canaryName)).toEqual([]);
    // Le nom libre dans un retour n'est pas un motif : il n'entre que masqué par le registre des valeurs x-personal du dossier.
    expect(renderCatalogMemory(dossier)).not.toContain(canaryName);

    const judge = judgeUserContent({ schema: SCHEMA, profile, items: run, token: '0'.repeat(24) });
    expect(leaked(judge)).toEqual([]);

    const reflect = maskFeedbackForLlm(`le champ note contient ${canaryMail} et ${canaryPhone}`);
    expect(leaked(reflect)).toEqual([]);

    const logged = JSON.stringify(maskPersonal({ note: run[0]!.note }));
    expect(leaked(logged)).toEqual([]);
  });

  test('canari libre à faible densité (2 notes sur 12, champ non annoté) : 0 occurrence dans le profil (top compris)', () => {
    const canaryMail = 'zz.low.density@example.test';
    const canaryPhone = '06 98 76 54 32';
    const run = Array.from({ length: 12 }, (_, i) => ({ name: 'x', note: i === 0 ? `écrire à ${canaryMail}` : i === 1 ? `appeler le ${canaryPhone}` : `note ordinaire ${i % 3}`, phone: null, price: i }));
    const profile = profileItems(run, SCHEMA);
    // Moins de 20 % des valeurs ont une allure personnelle : le champ n'est pas soupçonné, il garde un top-k… masqué.
    expect(profile.fields['note']!.suspected_personal).toBe(false);
    expect(profile.fields['note']!.top).toBeDefined();
    const text = JSON.stringify(profile);
    expect(text).not.toContain(canaryMail);
    expect(text).not.toContain(canaryPhone);
    expect(text).toContain('note ordinaire 1');
  });
});
