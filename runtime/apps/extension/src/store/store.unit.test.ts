// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.9 (07 § 7) : le paquet destiné au Chrome Web Store (non listé) et le texte de la fiche. La soumission elle-même
// est humaine ; ces tests garantissent que ce qui est déposé est propre, que chaque permission est justifiée et que la
// fiche ne promet rien que le CDC interdit.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, test } from 'vitest';
import { MANIFEST } from '../manifest.ts';

const EXT = new URL('../..', import.meta.url).pathname;
const ROOT = new URL('../../../..', import.meta.url).pathname; // runtime/
const listing = readFileSync(join(EXT, 'store/listing.md'), 'utf8');
const policy = readFileSync(join(EXT, 'store/privacy-policy.md'), 'utf8');

/** Contenu de la section `## <title>` du texte (jusqu'au prochain `## `). */
function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`section absente : ${title}`);
  const rest = text.slice(start + 1);
  const end = rest.indexOf('\n## ', 4);
  return (end < 0 ? rest : rest.slice(0, end)).split('\n').slice(1).join('\n').trim();
}

describe('assert_store_package_clean', () => {
  type Report = { zip: string; sha256: string; bytes: number; files: string[]; version: string; permissions: string[] };
  let run: SpawnSyncReturns<string>;
  let report: Report | null = null;
  beforeAll(() => {
    // Construit et audite le vrai zip (wxt zip) : une seule fois pour tout le bloc.
    run = spawnSync('node', ['scripts/extension-package.ts', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 240_000 });
    try {
      report = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '') as Report;
    } catch {
      report = null;
    }
  }, 260_000);

  test('la commande de paquet réussit et produit un zip avec manifeste, icônes et empreinte', () => {
    expect(run.status, run.stderr).toBe(0);
    expect(report).not.toBeNull();
    expect(report?.zip).toMatch(/scrapyomama-\d+\.\d+\.\d+-chrome\.zip$/);
    expect(report?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report?.files).toContain('manifest.json');
    for (const size of [16, 32, 48, 128]) expect(report?.files).toContain(`icons/${size}.png`);
  });

  test('aucun fichier hors paquet : pas de source map, pas de .env, pas de test ni de code source', () => {
    for (const f of report?.files ?? []) {
      expect(f, f).not.toMatch(/\.map$|\.env|\.test\.|\.ts$|\.py$|\.ipynb$|node_modules|\.git/);
    }
  });

  test('version de manifeste valide pour Chrome (1 à 4 entiers, non nulle) et permissions fixes de 07 § 4', () => {
    expect(report?.version).toMatch(/^\d{1,5}(\.\d{1,5}){0,3}$/);
    expect(report?.version.split('.').some((n) => Number(n) > 0)).toBe(true);
    expect([...(report?.permissions ?? [])].sort()).toEqual([...MANIFEST.permissions].sort());
  });

  test('le script refuse un paquet qui contiendrait <all_urls>, du code distant ou une permission en trop (contrôle de la grille)', () => {
    const check = spawnSync('node', ['scripts/extension-package.ts', '--self-test'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(check.status, check.stderr).toBe(0);
  });
});

describe('assert_store_listing_complete', () => {
  test('résumé (132 caractères max), catégorie, visibilité non listée, langue', () => {
    const summary = section(listing, 'Summary (132 characters max)');
    expect(summary.length).toBeGreaterThan(20);
    expect(summary.length).toBeLessThanOrEqual(132);
    expect(summary).toBe(MANIFEST.description);
    expect(section(listing, 'Visibility')).toMatch(/Unlisted/);
    expect(section(listing, 'Category')).toMatch(/\S/);
  });

  test('description détaillée : sans promesse hors périmètre (_exclusions.md) ni mot-clé de contournement', () => {
    const text = `${section(listing, 'Detailed description')}\n${section(listing, 'Single purpose')}`.replace(/\s+/g, ' ');
    expect(text.length).toBeGreaterThan(400);
    for (const banned of [/captcha/i, /stealth/i, /anti-?detect/i, /fingerprint/i, /bypass/i, /undetect/i, /rotat(e|ing) (ip|account)/i, /ignore robots/i, /impersonat/i]) {
      expect(text, String(banned)).not.toMatch(banned);
    }
    expect(text).toMatch(/your own Scrapyomama instance/i);
    expect(text).toMatch(/only (on )?the sites you (choose|connect)/i);
  });

  test('déclarations du tableau de bord du Store : code distant « No », données utilisateur, certifications, URL de politique', () => {
    expect(section(listing, 'Remote code')).toMatch(/^No\b/);
    const data = section(listing, 'Data usage disclosures');
    for (const kind of ['Authentication information', 'Website content', 'Personally identifiable information']) expect(data, kind).toContain(kind);
    expect(data).toMatch(/not sold/i);
    expect(data).toMatch(/not used or transferred for purposes that are unrelated/i);
    expect(data).toMatch(/not used or transferred to determine creditworthiness/i);
    expect(section(listing, 'Privacy policy URL')).toMatch(/store\/privacy-policy\.md/);
  });
});

describe('assert_store_permissions_justified', () => {
  const just = section(listing, 'Permission justifications');

  test('chaque permission du manifeste a sa justification, et seulement celles-là', () => {
    const named = [...just.matchAll(/^- `([^`]+)`/gm)].map((m) => m[1]);
    expect(named.filter((n) => !n?.includes('host')).sort()).toEqual([...MANIFEST.permissions].sort());
    for (const permission of MANIFEST.permissions) {
      const entry = just.split('\n').find((l) => l.startsWith(`- \`${permission}\``)) ?? '';
      expect(entry.length, permission).toBeGreaterThan(80);
    }
  });

  test('les hôtes optionnels sont justifiés comme demandés au clic, jamais en permission statique', () => {
    expect(just).toMatch(/- `optional_host_permissions`[^\n]*(click|consent)/i);
    expect(just).toMatch(/no (static )?host permission/i);
    expect(just).not.toContain('<all_urls>');
  });
});

describe('politique de confidentialité (URL stable, instances auto-hébergées comprises)', () => {
  test('couvre ce que l’extension lit, où cela va, ce qui n’est jamais fait et la révocation', () => {
    for (const topic of ['What the extension stores on your device', 'Cookies', 'Tunnel mode', 'Self-hosted', 'No sale, no advertising, no analytics', 'Revocation and deletion', 'Contact']) {
      expect(policy, topic).toContain(`## ${topic}`);
    }
    expect(policy).toMatch(/never sent to the instance/i);
    expect(policy).toMatch(/operator of the instance/i);
    expect(policy).toMatch(/no analytics/i);
  });
});
