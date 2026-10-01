// SPDX-License-Identifier: AGPL-3.0-only
// Vitrine du dépôt public (tâche oss-public-readiness, D-36, D-46 : les promesses restent vraies). Le README (en, fr) ne
// décrit au présent que ce qui existe dans le code ; un prix n'y figure pas sans source ; les garde-fous du .gitignore racine
// ne masquent que la racine ; aucun lien Markdown public ne pointe vers cdc/, jamais publié (D-44).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const runtimeDir = new URL('..', import.meta.url).pathname;
const repoRoot = join(runtimeDir, '..');
const read = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');
const README = { en: read('.github/README.md'), fr: read('.github/README.fr.md') };

/** Manifestes du workspace (racine, apps/*, packages/*). */
function manifests(): Record<string, unknown>[] {
  const paths = [join(runtimeDir, 'package.json')];
  for (const group of ['apps', 'packages']) {
    for (const entry of readdirSync(join(runtimeDir, group), { withFileTypes: true })) {
      const path = join(runtimeDir, group, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(path)) paths.push(path);
    }
  }
  return paths.map((p) => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>);
}
const dependsOn = (name: string): boolean =>
  manifests().some((m) => ['dependencies', 'devDependencies'].some((k) => Object.keys((m[k] as Record<string, string> | undefined) ?? {}).includes(name)));

/** Le serveur MCP (tâche 3.2) n'existe que si le SDK MCP est une dépendance ; l'API REST des API (3.1) que si une route `apis` existe. */
const MCP_DELIVERED = dependsOn('@modelcontextprotocol/sdk');
const REST_APIS_DELIVERED = readdirSync(join(runtimeDir, 'apps/server/src/routes')).some((f) => /^(apis|runs)\.ts$/.test(f));

/** Affirmations au présent du parcours cible (2.1, 2.3, 3.1, 3.2), interdites tant qu'il n'est pas livré. */
const PRESENT_CLAIMS = {
  en: [/Speaks MCP and REST/i, /Repairs itself/i, /\bSYM (investigates|compiles|repairs|looks for)\b/, /\byou ask your AI, over MCP\b/i],
  fr: [/Parle MCP et REST/i, /Se répare toute seule/i, /\bSYM (enquête|compile|répare|cherche)(?=[\s,.;:])/, /\btu demandes à ton IA, via MCP\b/i],
};

describe('README public : ce qui marche aujourd\'hui, distingué de ce qui est prévu', () => {
  test('bloc « What works today » / « Ce qui marche aujourd\'hui » juste après le bandeau de pré-version', () => {
    for (const [lang, heading] of [['en', '## What works today'], ['fr', '## Ce qui marche aujourd\'hui']] as const) {
      const text = README[lang];
      expect(text, lang).toContain(heading);
      expect(text.indexOf(heading), lang).toBeGreaterThan(text.indexOf('[!WARNING]'));
    }
  });

  test.skipIf(MCP_DELIVERED && REST_APIS_DELIVERED)('parcours non livré : aucune affirmation au présent, et le README dit ce qui manque', () => {
    for (const lang of ['en', 'fr'] as const) {
      for (const claim of PRESENT_CLAIMS[lang]) expect(README[lang], `${lang} : ${claim}`).not.toMatch(claim);
    }
    const missing = {
      en: /\*\*Not delivered yet\.\*\*[^\n]*investigation[^\n]*repair[^\n]*REST API[^\n]*MCP server/,
      fr: /\*\*Pas encore livré\.\*\*[^\n]*enquête[^\n]*réparation[^\n]*API REST[^\n]*serveur MCP/,
    };
    for (const lang of ['en', 'fr'] as const) expect(README[lang], lang).toMatch(missing[lang]);
  });

  test('parité en / fr : mêmes titres de section, même nombre de puces et d\'étapes', () => {
    const shape = (text: string) => ({
      sections: text.match(/^#{2,3} /gm)?.length ?? 0,
      bullets: text.match(/^- /gm)?.length ?? 0,
      steps: text.match(/^\d+\. /gm)?.length ?? 0,
    });
    expect(shape(README.fr)).toEqual(shape(README.en));
  });
});

describe('README public : aucun prix sans source', () => {
  test('aucun montant mensuel dans le README (en, fr)', () => {
    for (const lang of ['en', 'fr'] as const) {
      expect(README[lang], lang).not.toMatch(/\d+\s*(USD|US\$|\$|€|EUR)\b|\$\s*\d+/i);
    }
  });

  test('le guide de déploiement nomme chaque plan de render.yaml et renvoie à la grille de Render, datée', () => {
    const blueprint = parse(read('render.yaml')) as { services: { plan: string }[]; databases: { plan: string }[] };
    const plans = [...blueprint.services, ...blueprint.databases].map((r) => r.plan);
    const guide = readFileSync(join(runtimeDir, 'docs/deploiement.md'), 'utf8');
    const render = guide.slice(guide.indexOf('## Render'), guide.indexOf('## Docker Compose'));
    for (const plan of plans) expect(render, plan).toContain(`\`${plan}\``);
    expect(render).toMatch(/render\.com\/pricing/);
    expect(render).toMatch(/Coût[^\n]*\d{4}-\d{2}-\d{2}/);
  });
});

describe('.gitignore racine : les garde-fous locaux sont ancrés à la racine', () => {
  /** `git check-ignore --no-index` : 0 = ignoré, 1 = non ignoré, quel que soit l'état de l'index. */
  const ignored = (path: string): boolean => {
    const result = spawnSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: repoRoot });
    if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore : code ${result.status} pour ${path}`);
    return result.status === 0;
  };

  test('à la racine : ignorés', () => {
    for (const path of ['bin/x', '.claude/settings.local.json', '.playwright-mcp/page.png']) expect(ignored(path), path).toBe(true);
  });

  test('plus bas dans l\'arbre : jamais ignorés en silence', () => {
    for (const path of ['runtime/apps/cli/bin/x', 'runtime/tests/fixtures/bin/stub', 'runtime/x/.claude/settings.json', 'runtime/x/.playwright-mcp/a']) {
      expect(ignored(path), path).toBe(false);
    }
  });
});

/**
 * Protocole pré-enregistré du spike 0.6a : figé par son empreinte SHA-256 (eval/spike-0.6a-decision.sha256, 15 §11) avant tout
 * run. Le réécrire casserait la preuve de pré-enregistrement : son lien vers cdc/ reste, à traiter au filtrage du dépôt public.
 */
const FROZEN = new Set(['runtime/eval/spike-0.6a-decision.md']);

describe('dépôt public : aucun lien Markdown vers cdc/ (jamais publié, D-44)', () => {
  test('fichiers Markdown suivis sous runtime/ et .github/', () => {
    const listed = spawnSync('git', ['ls-files', '-z', '--', 'runtime/*.md', '.github/*.md'], { cwd: repoRoot, encoding: 'utf8' });
    expect(listed.status).toBe(0);
    const files = listed.stdout.split('\0').filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => !FROZEN.has(f) && /\]\([^)]*\bcdc\//.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
