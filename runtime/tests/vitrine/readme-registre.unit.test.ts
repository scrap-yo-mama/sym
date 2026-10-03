// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.12b, correctifs de vérification : le README et le registre des allégations (.github/claims.json) se correspondent.
// Une entrée de surface « readme » s'affiche dans le README ; un badge qui affirme un fait passe par le registre ; une mention
// « relu par des humains » cite une preuve de relecture humaine (la planche validée, D-60), pas la seule CI ; la politique de marque
// (runtime/TRADEMARK.md, u8 R17) est liée depuis les mentions.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { loadClaims } from '../../scripts/vitrine/lib/claims.ts';
import { readReadme } from '../../scripts/vitrine/lib/readme.ts';
import { normalize } from '../../scripts/vitrine/lib/text.ts';
import { runtimeDir } from '../../scripts/vitrine/lib/paths.ts';

const file = loadClaims();
const en = readReadme('en');
const fr = readReadme('fr');
const plainText = (s: string): string => normalize(s.replace(/\*\*/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, " $1 ").replace(/<[^>]+>/g, " ").replace(/\n>\s?/g, ' '));

describe('registre et README : même contenu', () => {
  test('toute entrée de surface « readme » s\'affiche dans le README (en ou fr)', () => {
    const notShown = file.claims
      .filter((c) => c.surfaces.includes('readme'))
      .filter((c) => !plainText(en).includes(plainText(c.en)) && !plainText(fr).includes(plainText(c.fr)))
      .map((c) => c.id);
    expect(notShown, notShown.join(", ")).toEqual([]);
  });

  test('le badge « releases: signed » passe par une entrée relue du registre, avec la preuve de la chaîne de release', () => {
    expect(en).toContain('alt="releases: signed"');
    const claim = file.claims.find((c) => c.surfaces.includes('readme') && c.en === 'releases: signed');
    expect(claim?.status).toBe('relu');
    expect(claim?.proof.some((p) => /release\.yml$/.test(p))).toBe(true);
    expect(claim?.proof.some((p) => /release\/dry-run\.ts$/.test(p))).toBe(true);
  });

  test('« reviewed by humans » cite la planche validée par l\'utilisateur (D-60), pas la seule CI', () => {
    const claim = file.claims.find((c) => c.id === 'readme-built-with-ai');
    expect(claim?.proof).toContain('decision:D-60');
  });

  test('les mentions lient la politique de marque (TRADEMARK.md), dans les deux langues', () => {
    for (const text of [en, fr]) {
      const closing = text.trimEnd().split('\n\n').pop()!;
      expect(closing).toMatch(/\]\([^)]*runtime\/TRADEMARK\.md\)/);
    }
    expect(readFileSync(join(runtimeDir, 'TRADEMARK.md'), 'utf8').length).toBeGreaterThan(0);
  });
});
