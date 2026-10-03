// SPDX-License-Identifier: AGPL-3.0-only
// Codes de raison (06 § 4.2) : chaque code de la table a sa ligne et sa traduction dans `en.json` et `fr.json`, les mêmes
// variables dans les deux langues ; les listes fermées (statuts, exécutions, réseaux, onglets) ont chacune leur libellé.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ACTION_CAUSE_CODES } from '@/lib/action-required';
import { API_TABS } from '@/lib/api-tabs';
import { DIFF_SUMMARY_CODES, EXTRA_REASON_CODES, REASON_CODES, SPEC_REASON_CODES } from '@/lib/reasons';
import { API_STATUSES, EXECUTIONS, NETWORKS } from '@/lib/status';
import en from './locales/en.json';
import fr from './locales/fr.json';

const locales = { en, fr } as const;
const variables = (message: string): string[] => [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();

/**
 * Liste figée des codes de la table de 06 § 4.2, versionnée avec le code : le CDC n'est pas dans le dépôt (absent en CI
 * et dans un worktree), la comparaison avec SPEC_REASON_CODES ne dépend donc jamais de sa présence.
 */
const SNAPSHOT = new URL('../testing/spec-reason-codes.json', import.meta.url);
function snapshotCodes(): string[] {
  expect(existsSync(SNAPSHOT), 'apps/web/src/testing/spec-reason-codes.json').toBe(true);
  return (JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { codes: string[] }).codes;
}

/**
 * Le CDC (06-specs-interface.md), quand il est disponible : à côté du dépôt (arbre principal) ou désigné par
 * SCRAPYOMAMA_CDC_DIR. Sert seulement à vérifier que la liste figée suit le CDC ; son absence est un saut visible.
 */
const CDC_SPEC = new URL('06-specs-interface.md', process.env.SCRAPYOMAMA_CDC_DIR ? `file://${process.env.SCRAPYOMAMA_CDC_DIR.replace(/\/?$/, '/')}` : new URL('../../../../../cdc/scrapyomama-runtime/', import.meta.url));
function cdcReasonCodes(): string[] {
  const section = /### 4\.2 Codes de raison([\s\S]*?)### 4\.3/.exec(readFileSync(CDC_SPEC, 'utf8'))?.[1] ?? '';
  return [...section.matchAll(/^\| `([a-z_]+)`/gm)].map((match) => match[1] ?? '');
}

describe('assert_reason_codes_stable', () => {
  test('chaque code de 06 § 4.2 a sa ligne et sa traduction, avec les mêmes variables en en et en fr', () => {
    for (const code of REASON_CODES) {
      for (const [name, messages] of Object.entries(locales)) {
        const message = (messages.reasons as Record<string, string>)[code];
        expect(message, `${name} reasons.${code}`).toBeTruthy();
      }
      const english = (en.reasons as Record<string, string>)[code] ?? '';
      const french = (fr.reasons as Record<string, string>)[code] ?? '';
      expect(variables(french), code).toEqual(variables(english));
    }
  });

  test('les langues n’ont aucun code en plus de la liste : un code ajouté exige sa ligne dans les deux langues', () => {
    expect(Object.keys(en.reasons).sort()).toEqual([...REASON_CODES].sort());
    expect(Object.keys(fr.reasons).sort()).toEqual([...REASON_CODES].sort());
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });

  test('la liste du code est celle de la table du CDC (06 § 4.2), ni plus ni moins, dans l’ordre de la table', () => {
    const codes = snapshotCodes();
    expect(codes).toHaveLength(25); // 27 avant D-91 (robots_disallowed et robots_unreachable retirés)
    // `not_found` est défini en 04 § 7 et listé avec les extras ; tous les autres codes de la table sont dans SPEC_REASON_CODES.
    expect([...SPEC_REASON_CODES]).toEqual(codes);
    expect(EXTRA_REASON_CODES).toContain('not_found');
  });

  // Écart du CDC (tâche 2.3, D-49) : le signal `items_rejected` (raison de la transition 5 et `degraded_reasons`) n'est pas
  // dans la table de 06 § 4.2. À ajouter à la table, à la liste figée, à SPEC_REASON_CODES, aux deux langues et à la doc
  // des codes de raison quand le CDC sera complété (reprise de la console, 3.x) ; d'ici là la console affiche le code brut.
  test.todo('items_rejected (D-49) : ligne de 06 § 4.2, libellé et phrase en fr et en en, doc des codes de raison');

  test.skipIf(!existsSync(CDC_SPEC))('la liste figée suit la table du CDC (06 § 4.2) quand le CDC est disponible', () => {
    expect(cdcReasonCodes()).toEqual(snapshotCodes());
  });

  test('un code stable n’est jamais une phrase : lettres minuscules, chiffres et tirets bas', () => {
    for (const code of REASON_CODES) expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
    for (const code of ACTION_CAUSE_CODES) expect(REASON_CODES, code).toContain(code);
  });

  test('libellés courts des codes de la table (listes de runs) et phrases de diff dans les deux langues', () => {
    for (const code of SPEC_REASON_CODES) {
      expect((en.reasonLabel as Record<string, string>)[code], code).toBeTruthy();
      expect((fr.reasonLabel as Record<string, string>)[code], code).toBeTruthy();
    }
    for (const code of [...DIFF_SUMMARY_CODES, 'generic']) {
      expect((en.diffSummary as Record<string, string>)[code], code).toBeTruthy();
      expect((fr.diffSummary as Record<string, string>)[code], code).toBeTruthy();
    }
  });

  test('statuts, exécutions, réseaux et onglets : un libellé par valeur, dans les deux langues', () => {
    for (const messages of Object.values(locales)) {
      for (const status of API_STATUSES) {
        expect((messages.status as Record<string, string>)[status], status).toBeTruthy();
        expect((messages.statusDefault as Record<string, string>)[status], status).toBeTruthy();
      }
      for (const execution of EXECUTIONS) expect((messages.execution as Record<string, string>)[execution], execution).toBeTruthy();
      for (const network of NETWORKS) expect((messages.network as Record<string, string>)[network], network).toBeTruthy();
      for (const tab of API_TABS) expect((messages.detail.tabs as Record<string, string>)[tab], tab).toBeTruthy();
    }
    // `stale` est un drapeau : son libellé existe, mais ce n'est pas un statut.
    expect(fr.status.staleFlag).toBeTruthy();
    expect(API_STATUSES as readonly string[]).not.toContain('staleFlag');
  });

  test('aucun texte de raison, de blocage ou d’action ne nomme un outil ou un éditeur de protection', () => {
    const vendors = /cloudflare|akamai|datadome|perimeterx|imperva|recaptcha|hcaptcha|turnstile|incapsula|kasada|f5 /i;
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'string') expect(value, path).not.toMatch(vendors);
      else if (typeof value === 'object' && value !== null) for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
    };
    walk(en, 'en');
    walk(fr, 'fr');
  });
});
