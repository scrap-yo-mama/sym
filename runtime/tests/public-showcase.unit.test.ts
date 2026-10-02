// SPDX-License-Identifier: AGPL-3.0-only
// Vitrine du dépôt public (tâche oss-public-readiness, D-36, D-46 : les promesses restent vraies). Le README (en, fr) ne
// décrit au présent que ce qui existe dans le code ; un prix n'y figure pas sans source ; les garde-fous du .gitignore racine
// ne masquent que la racine ; aucun lien Markdown public ne pointe vers cdc/, jamais publié (D-44).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { taskDeliveryDate } from '../scripts/vitrine/lib/claims.ts';

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

/**
 * Parcours cible, livré tâche par tâche : le serveur MCP (3.2) existe si son SDK serveur est une dépendance, l'API REST des API
 * (3.1) si une route `apis` existe, la réparation (2.3) si un fichier de ce nom est dans le worker ou l'agent, l'enquête (2.1)
 * si l'agent porte son rôle `investigate`. La reprise par étape (2.13, 19 §4 : « repairs step by step », « it repairs the step
 * that broke ») se lit dans l'historique : un commit de livraison « 2.13 — » (même source que le registre des allégations).
 */
const DELIVERED = {
  mcp: dependsOn('@modelcontextprotocol/server'),
  rest: readdirSync(join(runtimeDir, 'apps/server/src/routes')).some((f) => /^(apis|runs)\.ts$/.test(f)),
  repair: ['apps/worker/src', 'packages/agent/src'].some((dir) => existsSync(join(runtimeDir, dir)) && readdirSync(join(runtimeDir, dir), { recursive: true }).some((f) => /(^|[\\/])repair[^\\/]*\.ts$/.test(String(f)))),
  investigation: existsSync(join(runtimeDir, 'packages/agent/src/investigate.ts')),
  stepRepair: taskDeliveryDate('2.13') !== undefined,
};
type Feature = keyof typeof DELIVERED;
type Lang = 'en' | 'fr';

/**
 * Affirmations au présent du parcours cible, dans les mots de la planche (D-60), par fonction : chacune n'est admise que si sa
 * tâche est livrée, ou si la ligne « Not delivered yet » / « Pas encore livré » de l'alerte la nomme. Le gras et l'emoji de la
 * signature (`**SYM 👻**`) sont retirés avant la lecture.
 */
const PRESENT_CLAIMS: Record<Lang, [Feature, RegExp][]> = {
  en: [
    ['mcp', /\bSpeaks MCP\b/i],
    ['mcp', /\byou ask your AI\b/i],
    ['rest', /\bSpeaks MCP,? (and )?REST\b/i],
    ['repair', /\brepairs itself\b/i],
    ['stepRepair', /\brepairs (step by step|the step)\b/i],
    ['investigation', /\bSYM (investigates|compiles|repairs|looks for)\b/],
  ],
  fr: [
    ['mcp', /\bParle MCP\b/i],
    ['mcp', /\btu demandes (des données )?à ton IA\b/i],
    ['rest', /\bParle MCP,? (et )?REST\b/i],
    ['repair', /\bse répare\b/i],
    ['stepRepair', /\brépare (étape par étape|l['’]étape)/i],
    ['investigation', /\bSYM (enquête|compile|répare|cherche)(?=[\s,.;:])/],
  ],
};
/** Nom de chaque fonction sur la ligne « Not delivered yet » / « Pas encore livré ». */
const NAMED: Record<Lang, Record<Feature, RegExp>> = {
  en: { mcp: /MCP server/, rest: /REST API/, repair: /(?<!step-by-step )\brepair\b/, investigation: /investigation/, stepRepair: /step-by-step repair/ },
  fr: { mcp: /serveur MCP/, rest: /API REST/, repair: /réparation(?! étape)/, investigation: /enquête/, stepRepair: /réparation étape par étape/ },
};
/** Première phrase de la ligne « Not delivered yet » : la liste de ce qui manque (la phrase suivante dit ce qui marche d'ici là). */
const ALERT_LINE: Record<Lang, RegExp> = { en: /\*\*Not delivered yet:\*\*[^.\n]*/, fr: /\*\*Pas encore livré\s*:\*\*[^.\n]*/ };
/** Texte lu par la garde : sans gras ni emoji de signature (« **SYM 👻** investigates » → « SYM investigates »). */
const readable = (text: string): string => text.replace(/\*\*/g, '').replace(/\s*👻/gu, '');

/**
 * Les promesses restent vraies (D-46) : une affirmation au présent d'une fonction non livrée doit être nommée par la ligne
 * « Not delivered yet » ; cette ligne nomme chaque fonction non livrée, et aucune fonction livrée. Liste vide : conforme.
 */
function honestyProblems(text: string, lang: Lang, delivered: Record<Feature, boolean>): string[] {
  const problems: string[] = [];
  const alert = ALERT_LINE[lang].exec(text)?.[0] ?? '';
  const missing = (Object.keys(delivered) as Feature[]).filter((f) => !delivered[f]);
  for (const [feature, claim] of PRESENT_CLAIMS[lang]) {
    if (!delivered[feature] && !NAMED[lang][feature].test(alert) && claim.test(readable(text))) problems.push(`${lang} : « ${claim.source} » au présent, ${feature} non livré et absent de l'alerte`);
  }
  if (missing.length > 0 && alert === '') problems.push(`${lang} : ${missing.join(', ')} non livré(s), sans ligne « Not delivered yet »`);
  for (const feature of missing) if (alert !== '' && !NAMED[lang][feature].test(alert)) problems.push(`${lang} : la ligne « Not delivered yet » ne nomme pas ${feature}`);
  for (const feature of Object.keys(delivered) as Feature[]) {
    if (delivered[feature] && NAMED[lang][feature].test(alert)) problems.push(`${lang} : la ligne « Not delivered yet » nomme ${feature}, pourtant livré`);
  }
  if (missing.length === 0 && alert !== '') problems.push(`${lang} : tout est livré, la ligne « Not delivered yet » doit disparaître`);
  return problems;
}

describe('README public : ce qui marche aujourd\'hui, distingué de ce qui est prévu', () => {
  // 4.12b : la vitrine suit la planche (D-60, sans titre « What works today ») ; l'honnêteté de la pré-version tient dans l'alerte
  // `[!WARNING]` qui précède toutes les sections (registre claims.json pour les puces).
  test('alerte de pré-version avant « How it feels » / « Ce que ça donne »', () => {
    for (const [lang, heading] of [['en', '## How it feels'], ['fr', '## Ce que ça donne']] as const) {
      const text = README[lang];
      expect(text, lang).toContain(heading);
      expect(text.indexOf('[!WARNING]'), lang).toBeGreaterThan(-1);
      expect(text.indexOf(heading), lang).toBeGreaterThan(text.indexOf('[!WARNING]'));
    }
  });

  test('la garde lit les mots de la planche : chaque affirmation au présent du README est reconnue (gras et emoji compris)', () => {
    for (const lang of ['en', 'fr'] as const) {
      const seen = new Set(PRESENT_CLAIMS[lang].filter(([, claim]) => claim.test(readable(README[lang]))).map(([feature]) => feature));
      expect([...seen].sort(), lang).toEqual(['investigation', 'mcp', 'repair', 'rest', 'stepRepair']);
    }
  });

  test('parcours : chaque fonction non livrée est nommée par l\'alerte, aucune fonction livrée ne l\'est, une affirmation au présent attend sa livraison', () => {
    for (const lang of ['en', 'fr'] as const) expect(honestyProblems(README[lang], lang, DELIVERED), lang).toEqual([]);
  });

  test('cas négatifs : affirmation d\'une fonction non livrée sans alerte, fonction livrée encore nommée, ligne restée après livraison', () => {
    const none = { mcp: false, rest: false, repair: false, investigation: false, stepRepair: false };
    const all = { mcp: true, rest: true, repair: true, investigation: true, stepRepair: true };
    const bare = (lang: Lang) => README[lang].replace(new RegExp(`\\n>\\n> ${ALERT_LINE[lang].source}[^\\n]*`), '');
    expect(honestyProblems(bare('en'), 'en', { ...all, repair: false }).join()).toMatch(/repair.*non livré/);
    expect(honestyProblems(bare('fr'), 'fr', { ...all, mcp: false }).join()).toMatch(/mcp/);
    const named = (lang: Lang, line: string) => bare(lang).replace(/(\[!WARNING\]\n> [^\n]*)/, `$1\n>\n> ${line}`);
    expect(honestyProblems(named('en', '**Not delivered yet:** repair.'), 'en', { ...all, repair: false })).toEqual([]);
    expect(honestyProblems(named('fr', '**Pas encore livré :** la réparation.'), 'fr', { ...all, repair: false })).toEqual([]);
    expect(honestyProblems(named('en', '**Not delivered yet:** repair and the MCP server.'), 'en', { ...all, repair: false }).join()).toMatch(/nomme mcp, pourtant livré/);
    expect(honestyProblems(named('en', '**Not delivered yet:** the MCP server.'), 'en', all).join()).toMatch(/doit disparaître/);
    expect(honestyProblems(named('en', '**Not delivered yet:** repair.'), 'en', none).join()).toMatch(/ne nomme pas mcp/);
    // 2.13 : la reprise par étape se nomme seule ; « a repair » dans la phrase suivante ne nomme pas la réparation livrée.
    expect(honestyProblems(bare('en'), 'en', { ...all, stepRepair: false }).join()).toMatch(/stepRepair non livré/);
    expect(honestyProblems(named('en', '**Not delivered yet:** step-by-step repair. Until then, a repair patches the strategy.'), 'en', { ...all, stepRepair: false })).toEqual([]);
    expect(honestyProblems(named('fr', '**Pas encore livré :** la réparation étape par étape. D\'ici là, une réparation corrige la stratégie.'), 'fr', { ...all, stepRepair: false })).toEqual([]);
    expect(honestyProblems(named('en', '**Not delivered yet:** step-by-step repair.'), 'en', all).join()).toMatch(/doit disparaître|nomme stepRepair/);
    expect(honestyProblems(bare('en'), 'en', { ...all, investigation: false }).join()).toMatch(/SYM \(investigates.*investigation non livré/);
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
