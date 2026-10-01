// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.8 : contrôles de contenu du site de doc (16 § 4, 17 § 9, 17 § 11, _exclusions).
// - assert_docs_diataxis_structure : chaque page est dans un quadrant Diátaxis et son fichier existe ;
// - assert_responsible_use_sections : la page « Usage responsable » a ses 11 sections, dit « Ceci n'est pas un avis juridique »
//   et ne promet jamais la conformité ;
// - assert_out_of_scope_cites_x1_x6 : la page « Hors périmètre » cite X1 à X6 sans mode opératoire ;
// - assert_docs_env_in_sync : la référence des variables suit le code, dans les deux sens ;
// - assert_docs_commands_exist : toute commande `runtime …` citée existe dans la CLI.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { PAGES, QUADRANTS } from './nav.ts';
import { parseQuickstart, QUICKSTART_BASE_URL } from './quickstart.ts';
import { codeBlocks, contentDir, handWritten, markdownFiles, pageFile, prose, readSource, runtimeDir } from './testing/pages.ts';
import { existsSync } from 'node:fs';

describe('assert_docs_diataxis_structure : quatre quadrants, un registre unique', () => {
  test('chaque quadrant a des pages, chaque page est dans le dossier de son quadrant', () => {
    for (const quadrant of QUADRANTS) expect(PAGES.filter((p) => p.quadrant === quadrant.id).length, quadrant.id).toBeGreaterThan(0);
    for (const page of PAGES) expect(page.path.startsWith(`${page.quadrant}/`), page.path).toBe(true);
    expect(new Set(PAGES.map((p) => p.path)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((p) => p.title)).size, 'titres uniques').toBe(PAGES.length);
  });

  test('les pages écrites à la main existent ; aucun fichier de contenu n\'échappe au registre', () => {
    for (const page of handWritten) expect(existsSync(pageFile(page)), page.path).toBe(true);
    const known = new Set<string>(['index', ...PAGES.map((p) => p.path)]);
    expect(markdownFiles().filter((file) => !known.has(file)), 'page sur disque absente de src/nav.ts').toEqual([]);
  });

  test('les pages générées sont déclarées comme telles et ignorées par git', () => {
    const generated = PAGES.filter((p) => p.generated).map((p) => `content/${p.path}.md`);
    const ignore = readFileSync(join(contentDir, '..', '.gitignore'), 'utf8');
    for (const file of generated) expect(ignore, file).toContain(file);
  });

  test('chaque page porte un titre et une description, et un seul titre de premier niveau', () => {
    for (const page of handWritten) {
      const source = readSource(page);
      const front = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1] ?? '';
      const meta = parse(front) as { title?: string; description?: string };
      expect(meta.title, page.path).toBeTruthy();
      expect(meta.description, page.path).toBeTruthy();
      expect(prose(source).match(/^# .+$/gm)?.length, `${page.path} : un seul H1`).toBe(1);
    }
  });

  test('aucun texte ne tombe dans l\'interpolation Vue (double accolade hors code)', () => {
    for (const page of handWritten) expect(prose(readSource(page)), page.path).not.toContain('{{');
  });

  test('les liens internes pointent vers une page du site', () => {
    const known = new Set(PAGES.map((p) => p.path));
    for (const page of handWritten) {
      const source = prose(readSource(page));
      for (const match of source.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1] ?? '';
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        const [pathPart = ''] = target.split('#');
        const absolute = pathPart.startsWith('/') ? pathPart.slice(1) : join(dirname(page.path), pathPart);
        const normalized = resolve('/', absolute).slice(1).replace(/\.md$/, '').replace(/\/$/, '');
        const ok = normalized === 'llms.txt' || normalized === 'llms-full.txt' || normalized === '' || known.has(normalized);
        expect(ok, `${page.path} : lien ${target}`).toBe(true);
      }
    }
  });

  test('la page d\'accueil renvoie vers les quatre quadrants', () => {
    const home = readFileSync(join(contentDir, 'index.md'), 'utf8');
    for (const quadrant of QUADRANTS) {
      expect(home, quadrant.id).toContain(`link: /${quadrant.id}/`);
    }
    expect(home).toContain('/llms.txt');
  });
});

describe('assert_responsible_use_sections : « Usage responsable » (17 § 9 et § 11)', () => {
  const page = readSource('explications/usage-responsable');
  const TITLES = [
    'Qui est responsable',
    'Avant de collecter des données personnelles',
    'Ce que la CNIL dit du moissonnage',
    'Sites et conditions d\'utilisation',
    'Sessions et comptes',
    'Conservation',
    'Droits des personnes',
    'Données envoyées au LLM',
    'Usages déconseillés',
    'Cadence et bon voisinage',
    'Limites de ce document',
  ];

  test('les 11 sections existent, numérotées, dans l\'ordre de la spécification', () => {
    const headings = [...prose(page).matchAll(/^## (.+)$/gm)].map((m) => m[1] ?? '');
    expect(headings).toEqual(TITLES.map((title, index) => `${index + 1}. ${title}`));
  });

  test('« Ceci n\'est pas un avis juridique. » figure dans la dernière section', () => {
    const last = page.slice(page.indexOf('## 11.'));
    expect(last).toContain('Ceci n\'est pas un avis juridique.');
  });

  test('la page ne promet jamais la conformité', () => {
    const text = prose(page);
    expect(text).not.toMatch(/conforme\s+(au\s+)?RGPD/i);
    expect(text).not.toMatch(/RGPD[- ]compliant|garanti(?:t|e|s)?\s+(?:la\s+)?conformit/i);
    expect(text).toMatch(/aucune valeur de décharge/i);
  });

  test('elle cite les outils et les sources de la spécification', () => {
    for (const needle of ['export_subject', 'erase_subject', 'x-personal', 'llm.redact', 'robots.txt', 'Kaspr', 'reconnaissance faciale', 'cnil.fr', 'edpb.europa.eu']) {
      expect(page, needle).toContain(needle);
    }
    expect(page).toMatch(/à valider par un avocat/i);
  });

  test('chaque lien externe est une adresse https complète, sans paramètre de suivi', () => {
    for (const p of handWritten) {
      for (const match of readSource(p).matchAll(/\]\((https?:[^)\s]+)\)/g)) {
        const url = match[1] ?? '';
        expect(url.startsWith('https://'), `${p.path} : ${url}`).toBe(true);
        expect(url, `${p.path} : ${url}`).not.toMatch(/[?&](utm_|fbclid|gclid)/);
      }
    }
  });
});

/** Mêmes motifs que tests/ui-strings.unit.test.ts : aucun nom d'outil ni d'éditeur de protection dans un texte publié. */
const PROTECTION_NAMES = /data\s?dome|cloudflare|turnstile|perimeter\s?x|akamai|imperva|incapsula|kasada|shape\s?security|re-?captcha|h-?captcha|arkose|fun\s?captcha|geetest|anti-?captcha|2captcha|capsolver|flaresolverr|undetected|antidetect/i;

describe('assert_out_of_scope_cites_x1_x6 : « Hors périmètre » (16 § 2, _exclusions)', () => {
  const page = readSource('explications/hors-perimetre');
  const sibling = readFileSync(join(runtimeDir, 'docs/hors-perimetre.md'), 'utf8');
  const rows = (markdown: string): string[] => markdown.split('\n').filter((line) => /^\| X[1-6] \|/.test(line));

  test('les six exclusions X1 à X6 sont citées, chacune avec sa raison', () => {
    expect(rows(page).map((r) => r.slice(2, 4))).toEqual(['X1', 'X2', 'X3', 'X4', 'X5', 'X6']);
    for (const row of rows(page)) expect(row.split('|').filter((c) => c.trim() !== '').length, row).toBe(3);
  });

  test('aucun mode opératoire : pas de bloc de code, pas d\'adresse, aucun nom d\'outil ni d\'éditeur de protection', () => {
    expect(page).not.toContain('```');
    expect(page).not.toMatch(/https?:\/\//);
    expect(page).not.toMatch(PROTECTION_NAMES);
    expect(page).toMatch(/aucune méthode/i);
  });

  test('les six lignes et la réponse type sont identiques à docs/hors-perimetre.md du dépôt', () => {
    expect(rows(page)).toEqual(rows(sibling));
    const answer = /^> (Cette demande relève[^\n]*)$/m;
    const normalize = (text: string): string => text.replace(/\[Hors périmètre\]\([^)]*\)/, '[Hors périmètre]').replace(/\s+/g, ' ');
    expect(normalize(answer.exec(page)?.[1] ?? 'absente')).toBe(normalize(answer.exec(sibling)?.[1] ?? 'absente'));
  });

  test('l\'exclusion de robots.txt, du tunnel après blocage et de l\'identité sont dites', () => {
    const text = page.replace(/<!--[\s\S]*?-->/g, '');
    expect(text).toMatch(/robots\.txt/);
    expect(text).toMatch(/ne change jamais d'IP|jamais de changement d'IP/i);
    expect(text).toMatch(/à valider par un avocat/i);
  });

  test('aucune page du site ne nomme un outil ni un éditeur de protection', () => {
    for (const p of PAGES) {
      if (p.generated) continue;
      expect(readSource(p), p.path).not.toMatch(PROTECTION_NAMES);
    }
  });

  test('aucune page ne décrit une option pour ignorer robots.txt', () => {
    for (const p of handWritten) {
      expect(readSource(p), p.path).not.toMatch(/IGNORE_ROBOTS|ignore_robots|respect_robots\s*[:=]\s*false|robots\s*[:=]\s*['"]?(?:ignore|off)/i);
    }
  });
});

const sourceFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'testing', 'e2e', '.wxt', '.output'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.ts$/.test(entry) && !/\.(test|testkit)\.ts$/.test(entry)) out.push(full);
  }
  return out;
};

describe('assert_docs_env_in_sync : la référence des variables suit le code', () => {
  const page = readSource('reference/variables-environnement');
  type Row = { names: string[]; state: 'lue' | 'prévue' };
  const rows: Row[] = [];
  for (const line of page.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 7 || !/^`[A-Z]/.test(cells[1] ?? '')) continue;
    const state = cells[cells.length - 2];
    if (state !== 'lue' && state !== 'prévue') continue;
    rows.push({ names: [...(cells[1] ?? '').matchAll(/`([A-Z][A-Z0-9_]+)`/g)].map((m) => m[1] ?? ''), state });
  }
  const documented = new Map(rows.flatMap((r) => r.names.map((n) => [n, r.state] as const)));

  // Le code de l'instance, sans les tests, ni le catalogue de noms de diagnostics.ts (qui liste aussi des variables prévues).
  const files = ['apps/server/src', 'apps/worker/src', 'apps/cli/src', 'packages/core/src', 'packages/db/src', 'packages/llm/src']
    .flatMap((d) => sourceFiles(join(runtimeDir, d)))
    .filter((f) => !f.endsWith('ops/diagnostics.ts'));
  const corpus = [...files.map((f) => readFileSync(f, 'utf8')), readFileSync(join(runtimeDir, 'deploy/entrypoint.sh'), 'utf8')].join('\n');
  const reads = (name: string): boolean => new RegExp(`(?:['"\`.]|\\$\\{)${name}\\b`).test(corpus);

  test('la table est lisible : chaque ligne a un état « lue » ou « prévue »', () => {
    expect(documented.size).toBeGreaterThan(40);
  });

  test('une variable « lue » est lue par le code, une variable « prévue » ne l\'est pas encore', () => {
    for (const [name, state] of documented) {
      if (state === 'lue') expect(reads(name), `${name} est marquée « lue » mais le code ne la lit pas`).toBe(true);
      else expect(reads(name), `${name} est lue par le code : passez-la à « lue » dans la référence`).toBe(false);
    }
  });

  test('toute variable lue par le code est décrite', () => {
    const IGNORED = new Set([
      'NODE_ENV', // convention Node
      'RUNTIME_TEST_ALLOW_PRIVATE', // drapeau réservé aux tests, refusé au démarrage hors NODE_ENV=test
      'PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK', // réglage interne de Playwright
    ]);
    const patterns = [
      /\benv\[\s*'([A-Z][A-Z0-9_]{2,})'\s*\]/g,
      /\benv\.([A-Z][A-Z0-9_]{2,})\b/g,
      /\b(?:positive|oneOf|positiveInt|readSecretVariable|id)\(\s*(?:env,\s*)?'([A-Z][A-Z0-9_]{2,})'/g,
    ];
    const missing = new Set<string>();
    for (const pattern of patterns) {
      for (const match of corpus.matchAll(pattern)) {
        const name = match[1] ?? '';
        if (!IGNORED.has(name) && !documented.has(name) && !documented.has(name.replace(/_FILE$/, ''))) missing.add(name);
      }
    }
    expect([...missing].sort(), 'variables lues par le code et absentes de la référence').toEqual([]);
  });

  test('chaque nom du catalogue de diagnostics figure dans la référence', () => {
    const catalog = readFileSync(join(runtimeDir, 'packages/db/src/ops/diagnostics.ts'), 'utf8');
    const list = /DIAGNOSTIC_ENV_NAMES = \[([\s\S]*?)\] as const/.exec(catalog)?.[1] ?? '';
    const names = [...list.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1] ?? '');
    expect(names.length).toBeGreaterThan(20);
    const missing = names.filter((n) => !documented.has(n) && !documented.has(n.replace(/_FILE$/, '')));
    expect(missing).toEqual([]);
  });
});

describe('assert_docs_commands_exist : les commandes citées existent', () => {
  const cli = readFileSync(join(runtimeDir, 'apps/cli/src/cli.ts'), 'utf8');
  const commands = new Set([...cli.matchAll(/^\s+'\s+runtime ([a-z][a-z:-]*)/gm)].map((m) => m[1] ?? ''));

  test('la CLI expose bien les commandes documentées', () => {
    for (const name of ['migrate', 'keygen', 'key-check', 'rekey', 'doctor', 'diagnostics', 'export-catalog', 'backup', 'restore-prepare', 'secrets']) {
      expect(commands.has(name), name).toBe(true);
    }
  });

  test('toute commande `runtime …` d\'une page existe, et la page de référence les liste toutes', () => {
    for (const page of handWritten) {
      const source = readSource(page);
      const snippets = [...codeBlocks(source, 'bash'), ...[...source.matchAll(/`([^`\n]*)`/g)].map((m) => m[1] ?? '')];
      for (const snippet of snippets) {
        for (const match of snippet.matchAll(/(?:^|\s)runtime ([a-z][a-z:-]*)/g)) {
          const name = match[1] ?? '';
          if (name === 'migrate' || commands.has(name) || name === '--version') continue;
          expect(commands.has(name), `${page.path} : « runtime ${name} » n'existe pas`).toBe(true);
        }
      }
    }
    const reference = readSource('reference/cli');
    for (const name of commands) expect(reference, `runtime ${name}`).toContain(`runtime ${name}`);
  });
});

describe('guides de déploiement : configuration vérifiable', () => {
  test('les blocs YAML des pages sont valides, et l\'exemple Compose a ses cinq services', () => {
    for (const page of handWritten) {
      for (const block of codeBlocks(readSource(page), 'yaml')) expect(() => parse(block), page.path).not.toThrow();
    }
    const compose = parse(codeBlocks(readSource('guides/docker-compose'), 'yaml')[0] ?? '') as { services: Record<string, { depends_on?: Record<string, { condition: string }> }> };
    expect(Object.keys(compose.services).sort()).toEqual(['caddy', 'migrate', 'postgres', 'server', 'worker']);
    for (const service of ['server', 'worker']) expect(compose.services[service]?.depends_on?.['migrate']?.condition).toBe('service_completed_successfully');
  });

  test('aucune page ne conseille `latest`, un secret en clair dans une URL ou un TLS désactivé', () => {
    for (const page of handWritten) {
      const text = readSource(page);
      expect(text, page.path).not.toMatch(/image:\s*\S+:latest/);
      expect(text, page.path).not.toMatch(/sslmode=disable/);
    }
  });

  test('les guides disent la même chose que le code sur la clé maîtresse', () => {
    const guide = readSource('guides/deploiement');
    expect(guide).toContain('openssl rand -base64 32');
    expect(guide).toContain('/api/ready');
    expect(guide).toContain('DATABASE_URL_DIRECT');
    expect(guide).toContain('TRUST_PROXY');
  });
});

describe('quickstart : structure du tutoriel rejoué', () => {
  const steps = parseQuickstart(readSource('tutoriels/quickstart'));

  test('les étapes du tutoriel se suivent dans l\'ordre du parcours', () => {
    expect(steps.map((s) => s.id)).toEqual(['secrets', 'start', 'ready', 'owner-variables', 'setup', 'login', 'whoami', 'api-key', 'version', 'd0', 'first-api']);
  });

  test('les étapes rejouées visent l\'instance locale du tutoriel, avec curl en mode strict', () => {
    for (const step of steps.filter((s) => s.mode === 'run')) {
      for (const call of step.script.split('\n').filter((l) => l.trimStart().startsWith('curl'))) expect(call, step.id).toContain('-fsS');
      expect(step.script.includes('http://') ? step.script.includes(QUICKSTART_BASE_URL) : true, step.id).toBe(true);
    }
  });

  test('chaque étape non rejouée dit pourquoi, chaque étape lancée par Compose dit ce que fait le rejeu', () => {
    for (const step of steps.filter((s) => s.mode === 'pending')) expect(step.pending, step.id).toBeTruthy();
    for (const step of steps.filter((s) => s.mode === 'process')) expect(step.replay, step.id).toBeTruthy();
  });

  test('le tutoriel ne contacte aucun site : aucune adresse externe dans ses commandes', () => {
    for (const step of steps) {
      for (const url of step.script.match(/https?:\/\/[^\s'"\\]+/g) ?? []) expect(url.startsWith('http://localhost:'), `${step.id} : ${url}`).toBe(true);
    }
  });
});

/** Variables lues par un script shell (`$NOM`, `${NOM}`, `${NOM:-…}`), hors texte entre apostrophes. */
const variablesRead = (script: string): string[] => [...script.replace(/'[^']*'/g, "''").matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] ?? '');
/** Variables définies par un script shell (`NOM=…`, `export NOM=…`, `read NOM`). */
const variablesDefined = (script: string): string[] => [
  ...[...script.matchAll(/(?:^|[\s;(])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1] ?? ''),
  ...[...script.matchAll(/\bread\s+(?:-\S+\s+)*([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1] ?? ''),
];
/** Variables qu'un shell interactif a toujours. */
const SHELL_VARIABLES = new Set(['HOME', 'PATH', 'PWD', 'USER']);

describe('assert_quickstart_terminal_boundary : deux terminaux, rien ne passe de l\'un à l\'autre', () => {
  const source = readSource('tutoriels/quickstart');
  const steps = parseQuickstart(source);

  test('l\'étape qui lance l\'instance occupe le premier terminal ; la suite se fait dans un second, annoncé par la page', () => {
    const start = steps.findIndex((s) => s.mode === 'process');
    expect(start).toBeGreaterThanOrEqual(0);
    steps.forEach((step, index) => expect(step.terminal, step.id).toBe(index <= start ? 1 : 2));
    const afterStart = source.slice(source.indexOf(`"id":"${steps[start]?.id ?? ''}"`));
    const nextStep = afterStart.indexOf('<!-- quickstart', 1);
    expect(afterStart.slice(0, nextStep)).toMatch(/second terminal/i);
  });

  test('chaque variable lue par une étape est définie par une étape précédente du même terminal', () => {
    const defined = new Map<number, Set<string>>();
    for (const step of steps) {
      const known = defined.get(step.terminal) ?? new Set<string>();
      for (const name of variablesRead(step.script)) {
        if (SHELL_VARIABLES.has(name) || variablesDefined(step.script).includes(name)) continue;
        expect(known.has(name), `${step.id} (terminal ${step.terminal}) lit $${name}, jamais défini dans ce terminal`).toBe(true);
      }
      for (const name of variablesDefined(step.script)) known.add(name);
      defined.set(step.terminal, known);
    }
  });

  test('aucune étape ne change de dossier : tout se lance depuis runtime/, comme le dit la page', () => {
    expect(source).toMatch(/depuis son dossier `runtime\/`/);
    for (const step of steps) expect(step.script, step.id).not.toMatch(/(^|[;&|]\s*)cd\s/m);
  });

  test('les secrets vivent dans un fichier .env lu par Compose, que git ignore', () => {
    const secrets = steps.find((s) => s.id === 'secrets');
    expect(secrets?.script).toMatch(/> \.env/);
    expect(secrets?.script, 'umask 077 : fichier lisible par son seul propriétaire').toContain('umask 077');
    expect(secrets?.script, 'set -C : ne jamais écraser une MASTER_KEY existante').toContain('set -C');
    for (const ignore of [join(runtimeDir, '.gitignore'), join(runtimeDir, '..', '.gitignore')]) {
      expect(readFileSync(ignore, 'utf8').split('\n'), ignore).toContain('.env');
    }
  });

  test('la clé d\'API de l\'étape 6 est gardée dans une variable que D0 utilise', () => {
    expect(variablesDefined(steps.find((s) => s.id === 'api-key')?.script ?? '')).toContain('SCRAPYOMAMA_KEY');
    expect(variablesRead(steps.find((s) => s.id === 'd0')?.script ?? '')).toContain('SCRAPYOMAMA_KEY');
  });
});
