// SPDX-License-Identifier: AGPL-3.0-only
// Registre des langues (`locales/registry.json`, 21b § 2) : la seule liste des langues du produit. Seules les langues
// `shipped` entrent dans les sélecteurs ; `english_name` alimente le bloc `Language:` du LLM (jamais une saisie libre).

export type LanguageGate = 'shipped' | 'draft' | 'unmaintained';

export interface LanguageEntry {
  /** Étiquette BCP 47 sans région (`fr-CA` est replié sur `fr`) ; plage d'usage local `qaa` à `qtz` pour les essais. */
  readonly code: string;
  /** Nom de la langue dans la langue elle-même (sélecteur). */
  readonly endonym: string;
  /** Nom anglais, repris dans le bloc `Language:` du prompt LLM. */
  readonly english_name: string;
  readonly dir: 'ltr' | 'rtl';
  readonly maintainers: readonly string[];
  readonly gate: LanguageGate;
  /** Part des clés traduites (0 à 1) ; une langue communautaire entre dans le sélecteur au-delà de 0,9 (21 § 9). */
  readonly completeness: number;
}

export interface Registry {
  readonly languages: readonly LanguageEntry[];
  /** Espaces de noms jamais localisés (`mcp.model`). */
  readonly non_translatable: readonly string[];
  /** Comportement d'une clé absente : `omit` (jamais remplacée par l'anglais) ; absent = repli sur `en`. */
  readonly fallback: Readonly<Record<string, 'omit'>>;
}

/** Langue source et de repli : seul catalogue modifié par l'équipe. */
export const SOURCE_LOCALE = 'en';

const CODE = /^[a-z]{2,3}$/;
const GATES: readonly LanguageGate[] = ['shipped', 'draft', 'unmaintained'];

/** Valide le contenu de `registry.json` ; lève une `Error` qui nomme le champ en cause. */
export function parseRegistry(raw: unknown): Registry {
  if (typeof raw !== 'object' || raw === null) throw new Error('registry.json : objet attendu');
  const root = raw as Record<string, unknown>;
  if (!Array.isArray(root.languages) || root.languages.length === 0) throw new Error('registry.json : `languages` doit être une liste non vide');
  const seen = new Set<string>();
  const languages = root.languages.map((entry: unknown, index: number): LanguageEntry => {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const at = `registry.json languages[${index}]`;
    const str = (field: string): string => {
      const v = e[field];
      if (typeof v !== 'string' || v.trim() === '') throw new Error(`${at} : \`${field}\` manquant`);
      return v;
    };
    const code = str('code');
    if (!CODE.test(code)) throw new Error(`${at} : code « ${code} » invalide (2 ou 3 lettres minuscules, sans région)`);
    if (seen.has(code)) throw new Error(`${at} : code « ${code} » en double`);
    seen.add(code);
    const gate = str('gate') as LanguageGate;
    if (!GATES.includes(gate)) throw new Error(`${at} : gate « ${gate} » inconnue`);
    const dir = str('dir');
    if (dir !== 'ltr' && dir !== 'rtl') throw new Error(`${at} : dir « ${dir} » inconnue`);
    const maintainers = Array.isArray(e.maintainers) ? e.maintainers.filter((m): m is string => typeof m === 'string') : [];
    const completeness = typeof e.completeness === 'number' && e.completeness >= 0 && e.completeness <= 1 ? e.completeness : 0;
    return { code, endonym: str('endonym'), english_name: str('english_name'), dir, maintainers, gate, completeness };
  });
  if (!seen.has(SOURCE_LOCALE)) throw new Error('registry.json : la langue source `en` est obligatoire');
  const nonTranslatable = Array.isArray(root.non_translatable) ? root.non_translatable.filter((n): n is string => typeof n === 'string') : [];
  const fallback: Record<string, 'omit'> = {};
  if (typeof root.fallback === 'object' && root.fallback !== null) {
    for (const [ns, mode] of Object.entries(root.fallback)) if (mode === 'omit') fallback[ns] = 'omit';
  }
  return { languages, non_translatable: nonTranslatable, fallback };
}

/** Codes des langues `shipped` : la liste des sélecteurs, de `resolveLocale` et de la parité. `en` d'abord. */
export function shippedCodes(registry: Registry): string[] {
  const codes = registry.languages.filter((l) => l.gate === 'shipped').map((l) => l.code);
  return [SOURCE_LOCALE, ...codes.filter((c) => c !== SOURCE_LOCALE)];
}

export function languageEntry(registry: Registry, code: string): LanguageEntry | undefined {
  return registry.languages.find((l) => l.code === code);
}

/** Nom anglais d'une langue du registre (bloc `Language:` du LLM) ; `English` pour une langue inconnue. */
export function englishName(registry: Registry, code: string): string {
  return languageEntry(registry, code)?.english_name ?? 'English';
}
