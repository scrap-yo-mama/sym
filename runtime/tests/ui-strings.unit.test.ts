// SPDX-License-Identifier: AGPL-3.0-only
// assert_ui_strings_no_forbidden_words (INV6, 06 § 4.1, tâche 3.5) : aucun texte de raison, de blocage, d'action ou d'erreur
// (fichiers de langue `en` et `fr`, messages REST et MCP ; les libellés d'exécution E1 à E6 du badge sont exclus) ne contient
// « contourner », « débloquer », « passer » (ni leurs équivalents anglais : bypass, unblock, circumvent) ni le nom d'un outil
// ou d'un éditeur de protection. Le test lit les fichiers de langue en entier, extrait les messages de chaque route du
// serveur et des paquets partagés (apps/server/src et packages/*/src : `sendError`, `message:`, `what_to_do:`,
// `instructions:`, et `toolError(code, message)` des outils MCP, 3.2), dont tout fichier MCP, puis cherche les mots interdits ;
// les textes servis au modèle (MCP_INSTRUCTIONS, descriptions et schémas des outils, construits par concaténation) sont lus
// directement. Un module MCP né hors de ces dossiers (apps/worker, apps/cli…) fait échouer le test de périmètre.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';
import { apiToolDescription, BRIEF_SCHEMA, GENERIC_TOOLS, MCP_INSTRUCTIONS, NEW_API_BRIEF_PROMPT } from '../apps/server/src/mcp/tools.js';
import { BRIEF_ERROR_CODES, BRIEF_NARRATIVE, briefWhatToDo } from '../packages/core/src/brief/index.js';

const root = new URL('..', import.meta.url).pathname;

/** Mots interdits (06 § 4.1), formes françaises et anglaises. « mot(s) de passe » (champ de connexion) et « dépasser » ne sont pas des formes de « passer ». */
const FORBIDDEN =
  /contourn\p{L}*|débloqu\p{L}*|(?<!\p{L})pass(?:e|es|er|ez|ons|ent|é|ée|és|ées|ait|aient|ant|era|erai|erons|erez|eront)(?!\p{L})|bypass\p{L}*|unblock\p{L}*|circumvent\p{L}*/giu;

/** Noms d'outils et d'éditeurs de protection ou de résolution de défis : aucun texte affiché ne les nomme (06 § 2, X1 à X3). */
const PROTECTION_NAMES =
  /data\s?dome|cloudflare|turnstile|perimeter\s?x|akamai|imperva|incapsula|kasada|shape\s?security|re-?captcha|h-?captcha|arkose|fun\s?captcha|geetest|anti-?captcha|2captcha|capsolver|flaresolverr|undetected|antidetect|stealth/giu;

function forbiddenIn(text: string): string[] {
  const cleaned = text.replace(/\bmots? de passe\b/giu, ' ');
  return [...cleaned.matchAll(FORBIDDEN), ...cleaned.matchAll(PROTECTION_NAMES)].map((match) => match[0]);
}

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value] as [string, string]] : flatten(value, `${prefix}${key}.`)));
}

function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

const LITERAL = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|\x60((?:[^\x60\\]|\\.)*)\x60)`;
const MESSAGE_PATTERNS = [
  // sendError(reply, status, 'code', 'message')
  new RegExp(String.raw`sendError\(\s*[^,()]+,\s*[^,()]+,\s*[^,()]+,\s*${LITERAL}`, 'g'),
  // message: '…', what_to_do: '…', instructions: '…'
  new RegExp(String.raw`\b(?:message|what_to_do|instructions)\s*:\s*${LITERAL}`, 'g'),
  // toolError('code', 'message', …) : erreurs des outils MCP (05 § 4.3)
  new RegExp(String.raw`\btoolError\(\s*[^,()]+,\s*${LITERAL}`, 'g'),
];

/** Messages (texte littéral) d'un fichier source du serveur ou du MCP. */
function messagesOf(source: string): string[] {
  const out: string[] = [];
  for (const pattern of MESSAGE_PATTERNS) for (const match of source.matchAll(pattern)) out.push(match[1] ?? match[2] ?? match[3] ?? '');
  return out;
}

const isSource = (file: string): boolean => /\.ts$/.test(file) && !/\.(test|testkit)\.ts$/.test(file) && !file.includes(`${join('src', 'testing')}`);

/**
 * Dossiers lus par le contrôle des messages : le serveur (REST, et MCP s'il naît dans apps/server/src/mcp/) et chaque
 * packages/<nom>/src, où peuvent vivre la table des raisons partagée console, REST et MCP (06 § 4.1) et les messages MCP
 * (tâches 3.2, 3.10). Un module MCP né ailleurs fait échouer le test de périmètre.
 */
function messageRoots(): string[] {
  const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'src')))
    .map((entry) => `packages/${entry.name}/src`);
  return ['apps/server/src', ...packages];
}

/** Messages REST du serveur, des paquets partagés et du MCP (dossiers de messageRoots()), avec leur fichier. */
function serverMessages(): { where: string; text: string }[] {
  const files = messageRoots().flatMap((dir) => walk(join(root, dir), isSource));
  return files.flatMap((file) => messagesOf(readFileSync(file, 'utf8')).map((text) => ({ where: relative(root, file), text })));
}

const localesDir = join(root, 'packages/i18n/locales');
const locales = Object.fromEntries(['en', 'fr'].map((code) => [code, flatten(JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8')) as Tree)]));

describe('assert_ui_strings_no_forbidden_words', () => {
  test('fichiers de langue en et fr : 0 mot interdit, 0 nom d’outil de protection', () => {
    for (const [code, entries] of Object.entries(locales)) {
      expect(entries.length, code).toBeGreaterThan(100);
      for (const [key, text] of entries) {
        // Les libellés d'exécution E1 à E6 du badge sont exclus du test (06 § 4.1) ; ils ne contiennent d'ailleurs aucun mot interdit.
        if (key.startsWith('execution.')) continue;
        expect(forbiddenIn(text), `${code}:${key}`).toEqual([]);
      }
    }
  });

  test('messages REST et MCP (serveur et packages/*/src) : 0 mot interdit, 0 nom d’outil de protection', () => {
    const messages = serverMessages();
    // Le contrôle n'est pas vide : les routes livrées ont des messages d'erreur.
    expect(messages.length).toBeGreaterThan(10);
    for (const { where, text } of messages) expect(forbiddenIn(text), `${where} : « ${text} »`).toEqual([]);
  });

  test('périmètre : le serveur et chaque packages/*/src sont lus (table des raisons partagée console, REST et MCP, 06 § 4.1)', () => {
    const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'src')))
      .map((entry) => `packages/${entry.name}/src`);
    expect(packages.length).toBeGreaterThan(3);
    expect(messageRoots()).toEqual(expect.arrayContaining(['apps/server/src', ...packages]));
  });

  test('tout module MCP (fichier ou dossier dont le nom contient « mcp », dans apps/*/src ou packages/*/src) est sous un dossier lu', () => {
    const roots = messageRoots();
    const sources = ['apps', 'packages'].flatMap((top) =>
      readdirSync(join(root, top), { withFileTypes: true })
        // apps/web : ses textes sont dans les fichiers de langue, lus en entier par le premier test.
        .filter((entry) => entry.isDirectory() && existsSync(join(root, top, entry.name, 'src')) && !(top === 'apps' && entry.name === 'web'))
        .flatMap((entry) => walk(join(root, top, entry.name, 'src'), isSource)),
    );
    const mcp = sources.map((file) => relative(root, file)).filter((file) => /mcp/i.test(file));
    const outside = mcp.filter((file) => !roots.some((dir) => file.startsWith(`${dir}/`)));
    expect(outside, 'module MCP hors du périmètre du contrôle : ajouter son dossier à messageRoots()').toEqual([]);
  });

  test('textes MCP servis au modèle (instructions, descriptions et schémas des outils, description d’un outil par API) : 0 mot interdit', () => {
    const texts: [string, string][] = [
      ['MCP_INSTRUCTIONS', MCP_INSTRUCTIONS],
      ['apiToolDescription', apiToolDescription('zz-test')],
      ['BRIEF_SCHEMA', JSON.stringify(BRIEF_SCHEMA)],
      ['NEW_API_BRIEF_PROMPT', NEW_API_BRIEF_PROMPT],
      ...GENERIC_TOOLS.map((tool): [string, string] => [tool.name, JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema })]),
    ];
    expect(texts.length).toBeGreaterThan(10);
    for (const [where, text] of texts) expect(forbiddenIn(text), where).toEqual([]);
  });

  test('dossier d’enquête (2.14) : gabarits narrative.brief.* (en, fr), raisons brief_* et conduites des erreurs de dossier : 0 mot interdit', () => {
    const texts: [string, string][] = [
      ...Object.entries(BRIEF_NARRATIVE).flatMap(([locale, entries]) => Object.entries(entries).map(([key, text]): [string, string] => [`${locale}:${key}`, text])),
      ...BRIEF_ERROR_CODES.map((code): [string, string] => [code, briefWhatToDo(code)]),
    ];
    expect(texts.length).toBeGreaterThan(50);
    for (const [where, text] of texts) expect(forbiddenIn(text), where).toEqual([]);
  });

  test('tout fichier MCP des dossiers lus est couvert par le même contrôle dès qu’il existe', () => {
    const mcpFiles = messageRoots().flatMap((dir) => walk(join(root, dir), (file) => isSource(file) && /mcp/i.test(relative(root, file))));
    for (const file of mcpFiles) {
      for (const text of messagesOf(readFileSync(file, 'utf8'))) expect(forbiddenIn(text), `${relative(root, file)} : « ${text} »`).toEqual([]);
    }
  });

  test('les textes du panneau « Bloquée » et du bandeau « Action requise » sont couverts (clés présentes dans les deux langues)', () => {
    for (const entries of Object.values(locales)) {
      const keys = new Set(entries.map(([key]) => key));
      for (const key of ['blocked.title', 'blocked.what.protection', 'blocked.why.protection', 'blocked.todo.heading', 'action.challenge_in_tunnel.body', 'action.account_limit.body', 'reason.blocked_by_protection', 'reason.forbidden', 'blockedPanel.why.forbidden']) {
        expect(keys.has(key), key).toBe(true);
      }
    }
  });
});

describe('le détecteur de mots interdits', () => {
  test.each(['Passez outre', 'on passe outre la page', 'nous passons', 'passé outre', 'ils passent', 'il passait', 'passer', 'Contourne', 'contournement', 'débloquez', 'Débloquer', 'Bypassing', 'bypass', 'unblocked', 'circumvents', 'circumvention'])('reconnaît « %s »', (text) => {
    expect(forbiddenIn(text), text).not.toEqual([]);
  });

  test.each(['Mot de passe', 'mots de passe oubliés', 'Password', 'budget dépassé', 'Le délai est dépassé', 'passport', 'compass', 'Test passed', 'bloqué', 'Bloquée', 'refuse l’accès automatisé'])('laisse passer « %s »', (text) => {
    expect(forbiddenIn(text), text).toEqual([]);
  });

  test.each(['Cloudflare', 'DataDome', 'Turnstile', 'PerimeterX', 'Akamai', 'reCAPTCHA', 'hCaptcha', 'Anti-Captcha', '2Captcha', 'CapSolver', 'FlareSolverr', 'Imperva', 'Kasada', 'stealth mode', 'undetected browser'])('reconnaît le nom d’outil ou d’éditeur « %s »', (text) => {
    expect(forbiddenIn(text), text).not.toEqual([]);
  });

  test('l’extraction des messages du serveur lit sendError, message: et what_to_do:', () => {
    const source = "sendError(reply, 403, 'forbidden', 'action non autorisée');\nconst a = { message: \"deux\", what_to_do: `trois` };";
    expect(messagesOf(source)).toEqual(['action non autorisée', 'deux', 'trois']);
  });

  test('l’extraction lit aussi les messages des erreurs d’outil MCP (toolError(code, message…))', () => {
    const source = "return toolError('invalid_input', 'quatre');\nreturn toolError(code, `cinq ${x}`, { tool: 'list_apis' });";
    expect(messagesOf(source)).toEqual(['quatre', 'cinq ${x}']);
  });
});
