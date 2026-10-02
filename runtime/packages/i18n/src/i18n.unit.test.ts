// SPDX-License-Identifier: AGPL-3.0-only
// Paquet de langues (tâche 3.20, 21b § 4 M1, M2, M11, M12, M13, M14) : parité sur toutes les surfaces, résolution par tableau,
// formats comparés à la sortie d'`Intl`, signature `{sym}`, listes de mots interdits, 3e langue par fichiers de données.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { GHOST, checkParity, flatten, namespaceOf, placeholdersOf, type Catalog } from './catalog.js';
import { describeCronLocalized } from './cron.js';
import { fmtBytes, fmtDate, fmtDuration, fmtList, fmtRelative, fmtUsd, isValidTimeZone } from './format.js';
import { createI18n, DEFAULT_LOCALES_DIR, defaultI18n, render } from './node.js';
import { PSEUDO_CLOSE, PSEUDO_OPEN, pseudoCatalog, pseudoLocalize } from './pseudo.js';
import { SPEC_REASON_CODES } from './reason-codes.js';
import { shippedCodes } from './registry.js';
import { matchLocale, parseLanguageRanges, resolveLocale, type ResolveInput, type Source } from './resolve.js';

const SUPPORTED = ['en', 'fr'];

describe('M1 : parité sur toutes les surfaces', () => {
  const { registry, catalogs } = defaultI18n();
  const locales = shippedCodes(registry);

  test('assert_i18n_key_parity_all_surfaces : mêmes clés dans web, reason, ext, srv, narrative, email, mcp.user pour chaque langue livrée', () => {
    expect(checkParity(catalogs, registry, locales)).toEqual([]);
    const en = flatten(catalogs.en as Catalog);
    const fr = flatten(catalogs.fr as Catalog);
    for (const ns of ['web', 'reason', 'ext', 'srv', 'narrative', 'email', 'mcp.user']) {
      const inNs = [...en.keys()].filter((k) => namespaceOf(k) === ns);
      expect(inNs.length, `espace ${ns}`).toBeGreaterThan(0);
      for (const key of inNs) expect(fr.has(key), `fr ${key}`).toBe(true);
    }
  });

  test('assert_i18n_key_parity_all_surfaces : la détection voit une clé manquante, une clé en trop, une variable absente', () => {
    const broken = structuredClone(catalogs.fr) as { srv: { unknown_code: string; error: Record<string, string> }; email: Record<string, unknown> };
    delete broken.srv.error.not_found;
    broken.srv.unknown_code = 'sans variable';
    (broken.srv.error as Record<string, string>).zz_extra = 'en trop';
    const kinds = checkParity({ ...catalogs, fr: broken as unknown as Catalog }, registry, locales).map((p) => `${p.kind}:${p.key}`);
    expect(kinds).toContain('missing_key:srv.error.not_found');
    expect(kinds).toContain('placeholders:srv.unknown_code');
    expect(kinds).toContain('extra_key:srv.error.zz_extra');
  });

  test('assert_i18n_placeholders_match : variables, formes de pluriel et messages liés identiques en en et en fr', () => {
    const en = flatten(catalogs.en as Catalog);
    const fr = flatten(catalogs.fr as Catalog);
    let checked = 0;
    for (const [key, message] of en) {
      if (key.startsWith('mcp.model.')) continue;
      expect(placeholdersOf(fr.get(key) ?? ''), key).toEqual(placeholdersOf(message));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(1400);
  });

  test('assert_model_facing_namespace_untranslated : mcp.model.* n’existe qu’en en, le registre le déclare non traduisible', () => {
    expect(registry.non_translatable).toContain('mcp.model');
    expect([...flatten(catalogs.fr as Catalog).keys()].filter((k) => k.startsWith('mcp.model.'))).toEqual([]);
    expect([...flatten(catalogs.en as Catalog).keys()].filter((k) => k.startsWith('mcp.model.')).length).toBeGreaterThan(3);
    const withModel = structuredClone(catalogs.fr) as Record<string, unknown>;
    withModel.mcp = { ...(withModel.mcp as object), model: { instructions: { vital: 'traduit' } } };
    expect(checkParity({ ...catalogs, fr: withModel as Catalog }, registry, locales).map((p) => p.kind)).toContain('model_facing_translated');
  });

  test('assert_reason_codes_stable : reasons et reasonLabel portent exactement les codes de 06 § 4.2', () => {
    const en = flatten(catalogs.en as Catalog);
    for (const family of ['reasons', 'reasonLabel']) {
      const codes = [...en.keys()].filter((k) => k.startsWith(`${family}.`)).map((k) => k.slice(family.length + 1).split('.')[0] ?? '');
      for (const code of SPEC_REASON_CODES) expect(codes, `${family}.${code}`).toContain(code);
    }
    expect(SPEC_REASON_CODES).toHaveLength(27);
    expect(new Set(SPEC_REASON_CODES).size).toBe(27);
  });

  test('chaque clé ext.manifest.* existe en en et en fr (source du _locales généré)', () => {
    const keys = [...flatten(catalogs.en as Catalog).keys()].filter((k) => k.startsWith('ext.manifest.'));
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (const key of keys) expect(flatten(catalogs.fr as Catalog).has(key), key).toBe(true);
  });
});

describe('M2 : résolution de la langue', () => {
  const cases: { name: string; input: ResolveInput; expected: { locale: string; source: Source } }[] = [
    { name: 'console : compte', input: { surface: 'console', user: 'fr', instance: 'en' }, expected: { locale: 'fr', source: 'user' } },
    { name: 'console : le navigateur ne passe pas avant le compte', input: { surface: 'console', user: 'fr', request: 'en-US,en;q=0.9', instance: 'en' }, expected: { locale: 'fr', source: 'user' } },
    { name: 'console : instance puis en', input: { surface: 'console', user: null, instance: 'fr' }, expected: { locale: 'fr', source: 'instance' } },
    { name: 'console : défaut', input: { surface: 'console' }, expected: { locale: 'en', source: 'default' } },
    { name: 'pré-connexion : cookie', input: { surface: 'prelogin', cookie: 'fr', request: 'en', instance: 'en' }, expected: { locale: 'fr', source: 'cookie' } },
    { name: 'pré-connexion : Accept-Language', input: { surface: 'prelogin', request: 'fr-FR,fr;q=0.9,en;q=0.8', instance: 'en' }, expected: { locale: 'fr', source: 'request' } },
    { name: 'pré-connexion : instance', input: { surface: 'prelogin', request: 'de,es;q=0.5', instance: 'fr' }, expected: { locale: 'fr', source: 'instance' } },
    { name: 'extension appairée : compte', input: { surface: 'extension', user: 'fr', browser: 'en-US' }, expected: { locale: 'fr', source: 'user' } },
    { name: 'extension non appairée : navigateur', input: { surface: 'extension', browser: 'fr-CA' }, expected: { locale: 'fr', source: 'browser' } },
    { name: 'extension : défaut', input: { surface: 'extension', browser: 'ja' }, expected: { locale: 'en', source: 'default' } },
    { name: 'MCP : ?lang= remplace le compte', input: { surface: 'mcp', urlHint: 'en', user: 'fr' }, expected: { locale: 'en', source: 'explicit_url' } },
    { name: 'MCP : compte du propriétaire de la clé', input: { surface: 'mcp', user: 'fr', instance: 'en' }, expected: { locale: 'fr', source: 'user' } },
    { name: 'MCP V1 : acceptLanguage ignoré', input: { surface: 'mcp', request: 'fr', user: 'en' }, expected: { locale: 'en', source: 'user' } },
    { name: 'MCP : instance', input: { surface: 'mcp', instance: 'fr' }, expected: { locale: 'fr', source: 'instance' } },
    { name: 'REST : Accept-Language valide', input: { surface: 'rest', request: 'fr;q=0.9,en;q=0.5', user: 'en' }, expected: { locale: 'fr', source: 'request' } },
    { name: 'REST : compte du propriétaire de la clé', input: { surface: 'rest', request: '*', user: 'fr' }, expected: { locale: 'fr', source: 'user' } },
    { name: 'REST : en-tête absent', input: { surface: 'rest', instance: 'fr' }, expected: { locale: 'fr', source: 'instance' } },
    { name: 'e-mail d’invitation : invitation', input: { surface: 'email_invite', invitation: 'fr', instance: 'en' }, expected: { locale: 'fr', source: 'invitation' } },
    { name: 'e-mail d’invitation : instance', input: { surface: 'email_invite', instance: 'fr' }, expected: { locale: 'fr', source: 'instance' } },
    { name: 'e-mail à un compte : destinataire', input: { surface: 'email_user', user: 'fr', instance: 'en' }, expected: { locale: 'fr', source: 'user' } },
    { name: 'lecteur du récit : langue du lecteur', input: { surface: 'reader', user: 'fr' }, expected: { locale: 'fr', source: 'user' } },
    { name: 'lecteur du récit : en', input: { surface: 'reader', instance: 'fr' }, expected: { locale: 'en', source: 'default' } },
    { name: 'prose du LLM : runs.locale', input: { surface: 'llm', run: 'fr', user: 'en' }, expected: { locale: 'fr', source: 'run' } },
    { name: 'langue retirée du registre : valeur sautée', input: { surface: 'console', user: 'de', instance: 'fr' }, expected: { locale: 'fr', source: 'instance' } },
  ];
  test.each(cases)('assert_locale_resolution_order : $name', ({ input, expected }) => {
    expect(resolveLocale(input, SUPPORTED)).toEqual(expected);
  });

  test('assert_locale_resolution_order : q-values, régions repliées, jamais d’en-tête brut en sortie', () => {
    expect(parseLanguageRanges('fr;q=0.2, en;q=0.9, de;q=0, *;q=0.1')).toEqual(['en', 'fr']);
    expect(matchLocale('fr-CA,en;q=0.5', SUPPORTED)).toBe('fr');
    expect(matchLocale('FR_be', SUPPORTED)).toBe('fr');
    expect(matchLocale(';;;,,q=x', SUPPORTED)).toBeUndefined();
    const hostile = 'x'.repeat(5000);
    expect(resolveLocale({ surface: 'rest', request: hostile }, SUPPORTED)).toEqual({ locale: 'en', source: 'default' });
    const out = resolveLocale({ surface: 'rest', request: 'fr-FR,fr;q=0.9,en;q=0.8' }, SUPPORTED);
    expect(JSON.stringify(out)).not.toContain('0.9');
    expect(SUPPORTED).toContain(out.locale);
  });
});

describe('render', () => {
  test('rend un code dans la langue, pluriels de la langue, repli chaîne par chaîne sur en', () => {
    expect(render('srv.error.not_found', {}, 'fr')).toBe('Ressource introuvable.');
    expect(render('srv.error.not_found', {}, 'en')).toBe('Resource not found.');
    expect(render('narrative.reconnaissance_finished', { n: 1 }, 'en')).toContain('1 data source found');
    expect(render('narrative.reconnaissance_finished', { n: 2 }, 'fr')).toContain('2 sources de données trouvées');
    expect(render('narrative.reconnaissance_finished', { n: 0 }, 'fr')).toContain('0 source de données trouvée');
    expect(render('srv.error.not_found', {}, 'de')).toBe('Resource not found.');
  });

  test('code inconnu : texte générique localisé qui cite le code, jamais la clé brute', () => {
    expect(render('srv.error.zz_inconnu', {}, 'fr')).toBe("Cette version ne sait pas décrire ce qui vient d'arriver (code : srv.error.zz_inconnu).");
    expect(render('zz.nope', {}, 'en')).toContain('zz.nope');
    expect(render('zz.nope', {}, 'en')).not.toBe('zz.nope');
  });
});

describe('M11 : formats Intl', () => {
  test('assert_intl_formats_by_locale : fmtUsd en narrowSymbol, jamais « $US »', () => {
    expect(fmtUsd(0.5, 'fr')).toBe(new Intl.NumberFormat('fr', { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(0.5));
    expect(fmtUsd(0.5, 'fr')).toMatch(/^0,50\s\$$/);
    expect(fmtUsd(0.0021, 'fr')).toMatch(/^0,0021\s\$$/);
    expect(fmtUsd(0.5, 'en')).toBe('$0.50');
    expect(fmtUsd(0.5, 'fr')).not.toContain('US');
    expect(fmtUsd(0, 'fr')).toMatch(/^0,00\s\$/);
    // Moins de 1 $ : jusqu'à 4 décimales quand elles servent ; 1 $ et plus : 2.
    expect(fmtUsd(0.0123, 'en')).toBe('$0.0123');
    expect(fmtUsd(0.002, 'en')).toBe('$0.002');
    expect(fmtUsd(12.3456, 'en')).toBe('$12.35');
  });

  test('assert_intl_formats_by_locale : durées, tailles, listes, dates relatives par Intl', () => {
    const DurationFormat = (Intl as unknown as { DurationFormat: new (l: string, o: object) => { format(d: object): string } }).DurationFormat;
    expect(fmtDuration(72000, 'fr')).toBe(new DurationFormat('fr', { style: 'short' }).format({ minutes: 1, seconds: 12 }));
    expect(fmtDuration(1200, 'en')).toBe(new Intl.NumberFormat('en', { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: 1 }).format(1.2));
    expect(fmtDuration(240, 'fr')).toBe(new Intl.NumberFormat('fr', { style: 'unit', unit: 'millisecond', unitDisplay: 'short' }).format(240));
    expect(fmtBytes(1_500_000, 'fr')).toBe(new Intl.NumberFormat('fr', { style: 'unit', unit: 'megabyte', unitDisplay: 'short', maximumFractionDigits: 1 }).format(1.5));
    expect(fmtList(['a', 'b', 'c'], 'fr')).toBe(new Intl.ListFormat('fr', { style: 'long', type: 'conjunction' }).format(['a', 'b', 'c']));
    expect(fmtRelative(new Date('2026-10-02T10:00:00Z'), 'fr', new Date('2026-10-02T12:00:00Z'))).toBe(new Intl.RelativeTimeFormat('fr', { numeric: 'auto', style: 'short' }).format(-2, 'hour'));
  });

  test('assert_cron_description_locale : 0 8 * * 1-5 en 24 h en fr, 12 h en en ; langue absente de cronstrue : repli en signalé', async () => {
    const fr = await describeCronLocalized('0 8 * * 1-5', 'fr');
    const en = await describeCronLocalized('0 8 * * 1-5', 'en');
    expect(fr).toMatchObject({ locale: 'fr', fallback: false });
    expect(fr?.text).toContain('08:00');
    expect(fr?.text).toMatch(/lundi/i);
    expect(en?.text).toMatch(/AM/);
    const third = await describeCronLocalized('0 8 * * 1-5', 'qaa');
    expect(third).toMatchObject({ locale: 'en', fallback: true });
    expect(await describeCronLocalized('pas un cron', 'fr')).toBeNull();
  });

  test('assert_user_timezone_used_in_messages : heure dans le fuseau du compte, sinon UTC étiqueté', () => {
    const at = new Date('2026-10-02T12:00:00Z');
    expect(fmtDate(at, 'fr', 'Europe/Paris')).toContain('14:00');
    expect(fmtDate(at, 'fr', 'Europe/Paris')).toMatch(/UTC\+2|GMT\+2/);
    expect(fmtDate(at, 'fr')).toContain('12:00');
    expect(fmtDate(at, 'fr')).toContain('UTC');
    expect(fmtDate(at, 'fr', 'Pas/UnFuseau')).toContain('UTC');
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Paris')).toBe(false);
    // Alias : un navigateur annonce l'une ou l'autre forme (« America/Buenos_Aires », « America/Argentina/Buenos_Aires »).
    expect(isValidTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
    expect(isValidTimeZone('Europe/Paris; DROP TABLE users')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});

describe('M12 : signature {sym}', () => {
  test('assert_sym_signature_placeholder_only : aucun catalogue ne contient U+1F47B', () => {
    const { catalogs } = defaultI18n();
    for (const [code, tree] of Object.entries(catalogs)) {
      for (const [key, message] of flatten(tree)) expect(message.includes(GHOST), `${code} ${key}`).toBe(false);
    }
    for (const file of readdirSync(DEFAULT_LOCALES_DIR).filter((f) => f.endsWith('.json'))) {
      expect(readFileSync(join(DEFAULT_LOCALES_DIR, file), 'utf8').includes(GHOST), file).toBe(false);
    }
  });
});

describe('M13 : mots interdits par langue', () => {
  test('assert_forbidden_words_per_locale : une langue livrée sans forbidden.<langue>.txt fait échouer', () => {
    const { registry } = defaultI18n();
    for (const code of shippedCodes(registry)) {
      const file = join(DEFAULT_LOCALES_DIR, `forbidden.${code}.txt`);
      expect(existsSync(file), `forbidden.${code}.txt`).toBe(true);
      const words = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'));
      expect(words.length, code).toBeGreaterThan(3);
      // Chaque liste reprend les termes de promesse anglais (21 § 7).
      for (const term of ['stealth', 'bypass', 'undetectable', 'anti-detect']) expect(words, `${code} ${term}`).toContain(term);
    }
  });
});

describe('pseudo-locale', () => {
  test('accents, crochets, variables et formes de pluriel intactes ; mcp.model.* non pseudo-localisé', () => {
    const out = pseudoLocalize('Hello {name}, you have {n} item | {n} items');
    expect(out.startsWith(PSEUDO_OPEN)).toBe(true);
    expect(out.endsWith(PSEUDO_CLOSE)).toBe(true);
    expect(out).toContain('{name}');
    expect(out.split(' | ')).toHaveLength(2);
    expect(out).not.toContain('Hello');
    const catalog = pseudoCatalog(defaultI18n().catalogs.en as Catalog);
    const flat = flatten(catalog);
    for (const [key, message] of flat) {
      if (key.startsWith('mcp.model.')) expect(message.includes(PSEUDO_OPEN), key).toBe(false);
      else expect(message.includes(PSEUDO_OPEN), key).toBe(true);
    }
    const en = flatten(defaultI18n().catalogs.en as Catalog);
    for (const [key, message] of en) if (!key.startsWith('mcp.model.')) expect(placeholdersOf(flat.get(key) ?? ''), key).toEqual(placeholdersOf(message));
  });
});

describe('M14 : 3e langue sans modification de code', () => {
  test('assert_third_locale_no_code_change : une langue qaa ajoutée par fichiers de données seulement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'i18n-qaa-'));
    cpSync(DEFAULT_LOCALES_DIR, dir, { recursive: true });
    cpSync(join(dir, 'fr.json'), join(dir, 'qaa.json'));
    cpSync(join(dir, 'forbidden.fr.txt'), join(dir, 'forbidden.qaa.txt'));
    const registry = JSON.parse(readFileSync(join(dir, 'registry.json'), 'utf8')) as { languages: object[] };
    registry.languages.push({ code: 'qaa', endonym: 'Essai local', english_name: 'Local test language', dir: 'ltr', maintainers: ['zz_test'], gate: 'shipped', completeness: 1 });
    writeFileSync(join(dir, 'registry.json'), JSON.stringify(registry));
    const i18n = createI18n(dir);
    expect(i18n.supported).toEqual(['en', 'fr', 'qaa']);
    expect(checkParity(i18n.catalogs, i18n.registry, i18n.supported)).toEqual([]);
    expect(resolveLocale({ surface: 'console', user: 'qaa' }, i18n.supported)).toEqual({ locale: 'qaa', source: 'user' });
    expect(i18n.renderer.render('srv.error.not_found', {}, 'qaa')).toBe('Ressource introuvable.');
    expect(i18n.renderer.render('narrative.reconnaissance_finished', { n: 2 }, 'qaa')).toContain('2 sources');
    // Une entrée cronstrue manquante donne un repli en signalé, pas une erreur.
    expect(await describeCronLocalized('0 8 * * 1-5', 'qaa')).toMatchObject({ fallback: true });
    // Parité cassée dans la nouvelle langue : détectée.
    const broken = JSON.parse(readFileSync(join(dir, 'qaa.json'), 'utf8')) as { srv: { error: Record<string, string> } };
    delete broken.srv.error.internal;
    writeFileSync(join(dir, 'qaa.json'), JSON.stringify(broken));
    const again = createI18n(dir);
    expect(checkParity(again.catalogs, again.registry, again.supported).map((p) => p.key)).toContain('srv.error.internal');
  });

  test('assert_third_locale_no_code_change : aucune liste de langues codée en dur dans les sources (hors tests)', () => {
    const root = new URL('../../../', import.meta.url).pathname;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (['node_modules', 'dist', '.wxt', 'generated', 'e2e', 'eval', '.output'].includes(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|vue)$/.test(name) && !/\.(test|e2e)\.ts$/.test(name) && !/\.d\.ts$/.test(name)) {
          const text = readFileSync(full, 'utf8');
          if (/\[\s*['"]en['"]\s*,\s*['"]fr['"]\s*\]/.test(text) || /['"]en['"]\s*\|\s*['"]fr['"]/.test(text) || /IN\s*\(\s*'en'\s*,\s*'fr'\s*\)/.test(text)) offenders.push(full.slice(root.length));
        }
      }
    };
    for (const sub of ['apps', 'packages']) for (const entry of readdirSync(join(root, sub))) {
      const src = join(root, sub, entry, 'src');
      if (existsSync(src)) walk(src);
    }
    expect(offenders).toEqual([]);
  });
});
