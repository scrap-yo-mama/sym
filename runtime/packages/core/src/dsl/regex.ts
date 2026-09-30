// Motifs I-Regexp (RFC 9485) bornés. Aucun motif d'utilisateur n'atteint `RegExp` sans être passé ici :
// grammaire I-Regexp stricte, puis bornes qui écartent le retour arrière catastrophique.
//   - longueur du motif <= 256 caractères ; profondeur de groupes <= 8 ;
//   - au plus 2 quantificateurs non bornés (`*`, `+`, `{n,}`) ; répétitions bornées <= 100 ;
//   - aucun quantificateur sur un groupe qui contient déjà un quantificateur ou une alternance ;
//   - texte examiné borné selon le nombre k de quantificateurs non bornés : n^(k+1) <= 2e7 (recherche non ancrée), n <= 4 096.
//     k = 0 ou 1 : 4 096 caractères ; k = 2 : 271 caractères. Pire cas résiduel : quelques dizaines de ms.
import { DslError } from './errors.js';

const MAX_REGEX_PATTERN = 256;
const MAX_REGEX_SUBJECT = 4_096;
const STEP_BUDGET = 2e7;

/** Longueur maximale du texte pour un motif à `unbounded` quantificateurs non bornés (coût en O(n^(k+1))). */
function maxSubjectLength(unbounded: number): number {
  return Math.min(MAX_REGEX_SUBJECT, Math.floor(STEP_BUDGET ** (1 / (unbounded + 1))));
}
const MAX_GROUP_DEPTH = 8;
const MAX_UNBOUNDED = 2;
const MAX_REPEAT = 100;

const CATEGORIES = new Set([
  'L', 'Ll', 'Lm', 'Lo', 'Lt', 'Lu', 'M', 'Mc', 'Me', 'Mn', 'N', 'Nd', 'Nl', 'No',
  'P', 'Pc', 'Pd', 'Pe', 'Pf', 'Pi', 'Po', 'Ps', 'Z', 'Zl', 'Zp', 'Zs', 'S', 'Sc', 'Sk', 'Sm', 'So',
  'C', 'Cc', 'Cf', 'Cn', 'Co',
]);

// SingleCharEsc : \ suivi de ( ) * + - . ? [ \ ] ^ { | } n r t
const SINGLE_ESC = new Set(['(', ')', '*', '+', '-', '.', '?', '[', '\\', ']', '^', '{', '|', '}', 'n', 'r', 't']);
const NORMAL_EXCLUDED = new Set(['.', '\\', '?', '*', '+', '{', '}', '(', ')', '|', '[', ']']);

interface GroupInfo {
  hasQuantifier: boolean;
  hasAlternation: boolean;
}

class Parser {
  readonly #cps: string[];
  #i = 0;
  unbounded = 0;
  out = '';

  constructor(pattern: string) {
    this.#cps = Array.from(pattern);
  }

  fail(message: string): never {
    throw new DslError('invalid_regex', `motif refusé : ${message}`);
  }

  notBounded(message: string): never {
    throw new DslError('regex_not_bounded', `motif refusé : ${message}`);
  }

  parseAll(): void {
    this.parseRegexp(0);
    if (this.#i < this.#cps.length) this.fail('caractère inattendu');
  }

  #peek(): string | undefined {
    return this.#cps[this.#i];
  }

  parseRegexp(depth: number): GroupInfo {
    if (depth > MAX_GROUP_DEPTH) this.notBounded(`groupes imbriqués sur plus de ${MAX_GROUP_DEPTH} niveaux`);
    const info: GroupInfo = { hasQuantifier: false, hasAlternation: false };
    for (;;) {
      this.#parseBranch(depth, info);
      if (this.#peek() === '|') {
        this.#i += 1;
        info.hasAlternation = true;
        this.out += '|';
        continue;
      }
      return info;
    }
  }

  #parseBranch(depth: number, info: GroupInfo): void {
    for (;;) {
      const c = this.#peek();
      if (c === undefined || c === '|' || c === ')') return;
      const atomInfo = this.#parseAtom(depth);
      const quant = this.#parseQuantifier();
      if (quant !== null) {
        if (atomInfo !== null && (atomInfo.hasQuantifier || atomInfo.hasAlternation) && quant.max !== 1) {
          this.notBounded('quantificateur sur un groupe qui contient déjà une répétition ou une alternance');
        }
        if (quant.max === Infinity) {
          this.unbounded += 1;
          if (this.unbounded > MAX_UNBOUNDED) this.notBounded(`plus de ${MAX_UNBOUNDED} répétitions non bornées`);
        }
        info.hasQuantifier = true;
      }
      if (atomInfo?.hasQuantifier === true) info.hasQuantifier = true;
      if (atomInfo?.hasAlternation === true) info.hasAlternation = true;
    }
  }

  /** Retourne les infos du groupe si l'atome en est un, sinon `null`. */
  #parseAtom(depth: number): GroupInfo | null {
    const c = this.#peek() as string;
    this.#i += 1;
    if (c === '(') {
      this.out += '(';
      const inner = this.parseRegexp(depth + 1);
      if (this.#peek() !== ')') this.fail('parenthèse fermante manquante');
      this.#i += 1;
      this.out += ')';
      return inner;
    }
    if (c === '.') {
      this.out += '[^\\n\\r]';
      return null;
    }
    if (c === '[') {
      this.#parseClass();
      return null;
    }
    if (c === '\\') {
      const next = this.#peek();
      if (next === undefined) this.fail('échappement incomplet');
      if (next === 'p' || next === 'P') {
        this.out += this.#parseCategory();
        return null;
      }
      this.#i += 1;
      this.out += this.#singleEscape(next, false);
      return null;
    }
    if (NORMAL_EXCLUDED.has(c)) this.fail('caractère spécial hors échappement');
    this.out += c === '^' || c === '$' ? `\\${c}` : c;
    return null;
  }

  #singleEscape(ch: string, inClass: boolean): string {
    if (!SINGLE_ESC.has(ch)) this.fail('échappement inconnu');
    if (ch === 'n') return '\\n';
    if (ch === 'r') return '\\r';
    if (ch === 't') return '\\t';
    if (ch === '-') return inClass ? '\\-' : '-';
    return `\\${ch}`;
  }

  /** Au niveau de `p` ou `P` (le `\` est déjà consommé). */
  #parseCategory(): string {
    const letter = this.#cps[this.#i] as string;
    this.#i += 1;
    if (this.#peek() !== '{') this.fail('catégorie attendue après \\p');
    const end = this.#cps.indexOf('}', this.#i);
    if (end === -1) this.fail('catégorie non fermée');
    const name = this.#cps.slice(this.#i + 1, end).join('');
    if (!CATEGORIES.has(name)) this.fail('catégorie Unicode inconnue');
    this.#i = end + 1;
    return `\\${letter}{${name}}`;
  }

  #parseClass(): void {
    let out = '[';
    if (this.#peek() === '^') {
      this.#i += 1;
      out += '^';
    }
    let count = 0;
    let closed = false;
    while (this.#i < this.#cps.length) {
      const c = this.#cps[this.#i] as string;
      if (c === ']' && count > 0) {
        this.#i += 1;
        closed = true;
        break;
      }
      if (c === '-' && (count === 0 || this.#cps[this.#i + 1] === ']')) {
        this.#i += 1; // tiret littéral en tête ou en queue de classe
        out += '\\-';
        count += 1;
        continue;
      }
      if (c === '\\' && (this.#cps[this.#i + 1] === 'p' || this.#cps[this.#i + 1] === 'P')) {
        this.#i += 1;
        out += this.#parseCategory();
        count += 1;
        continue;
      }
      const lo = this.#classChar();
      count += 1;
      if (this.#peek() === '-' && this.#cps[this.#i + 1] !== ']' && this.#cps[this.#i + 1] !== undefined) {
        this.#i += 1;
        const hi = this.#classChar();
        if (lo.code > hi.code) this.fail('intervalle de classe inversé');
        out += `${lo.text}-${hi.text}`;
      } else {
        out += lo.text;
      }
    }
    if (!closed) this.fail('classe de caractères non fermée');
    this.out += `${out}]`;
  }

  #classChar(): { text: string; code: number } {
    const c = this.#cps[this.#i] as string;
    this.#i += 1;
    if (c === '\\') {
      const next = this.#peek();
      if (next === undefined) this.fail('échappement incomplet');
      this.#i += 1;
      const text = this.#singleEscape(next, true);
      const code = next === 'n' ? 10 : next === 'r' ? 13 : next === 't' ? 9 : (next.codePointAt(0) as number);
      return { text, code };
    }
    // CCchar exclut '-', '\', '[' et ']'
    if (c === '-' || c === '[' || c === ']') this.fail('caractère de classe interdit hors échappement');
    return { text: c === '^' ? '\\^' : c, code: c.codePointAt(0) as number };
  }

  /** `{ max }` (Infinity si non borné) ou `null` s'il n'y a pas de quantificateur. */
  #parseQuantifier(): { max: number } | null {
    const c = this.#peek();
    if (c === '*' || c === '+') {
      this.#i += 1;
      this.out += c;
      return { max: Infinity };
    }
    if (c === '?') {
      this.#i += 1;
      this.out += '?';
      return { max: 1 };
    }
    if (c !== '{') return null;
    this.#i += 1;
    const min = this.#digits();
    let max = min;
    let text = `{${min}`;
    if (this.#peek() === ',') {
      this.#i += 1;
      text += ',';
      if (this.#peek() === '}') {
        max = Infinity;
      } else {
        max = this.#digits();
        text += String(max);
      }
    }
    if (this.#peek() !== '}') this.fail('accolade fermante manquante');
    this.#i += 1;
    if (min > MAX_REPEAT || (max !== Infinity && max > MAX_REPEAT)) this.notBounded(`répétition > ${MAX_REPEAT}`);
    if (max !== Infinity && min > max) this.fail('intervalle de répétition inversé');
    this.out += `${text}}`;
    return { max };
  }

  #digits(): number {
    let s = '';
    while (this.#peek() !== undefined && /^[0-9]$/.test(this.#peek() as string)) {
      s += this.#peek() as string;
      this.#i += 1;
      if (s.length > 4) this.notBounded('répétition trop grande');
    }
    if (s === '') this.fail('nombre attendu dans le quantificateur');
    return Number(s);
  }
}

interface BoundedPattern {
  /** Source JavaScript équivalente (drapeau `u`). */
  source: string;
  /** Longueur maximale du texte examiné. */
  maxSubject: number;
}

/** Valide un motif I-Regexp borné. Lève `DslError`. */
function analyzeRegex(pattern: string): BoundedPattern {
  if (typeof pattern !== 'string') throw new DslError('invalid_regex', 'motif refusé : chaîne attendue');
  if (pattern.length > MAX_REGEX_PATTERN) throw new DslError('regex_not_bounded', `motif refusé : plus de ${MAX_REGEX_PATTERN} caractères`);
  const parser = new Parser(pattern);
  parser.parseAll();
  return { source: parser.out, maxSubject: maxSubjectLength(parser.unbounded) };
}

/** Vérifie seulement (I-Regexp + bornes) et retourne la longueur maximale du texte examiné. */
export function assertBoundedRegex(pattern: string): number {
  return analyzeRegex(pattern).maxSubject;
}

/** Refuse un texte trop long pour ce motif. */
export function assertSubjectFits(text: string, maxSubject: number): void {
  if (text.length > maxSubject) throw new DslError('value_too_large', `texte trop long pour ce motif (> ${maxSubject} caractères)`);
}

const cache = new Map<string, { re: RegExp; maxSubject: number }>();

/** Compile (avec cache) un motif borné : recherche non ancrée. */
export function compileBoundedRegex(pattern: string): { re: RegExp; maxSubject: number } {
  const hit = cache.get(pattern);
  if (hit !== undefined) return hit;
  const { source, maxSubject } = analyzeRegex(pattern);
  let re: RegExp;
  try {
    re = new RegExp(source, 'u');
  } catch (cause) {
    throw new DslError('invalid_regex', 'motif refusé : non compilable', { cause });
  }
  const entry = { re, maxSubject };
  cache.set(pattern, entry);
  if (cache.size > 256) cache.delete(cache.keys().next().value as string);
  return entry;
}

/** Premier appariement de `pattern` dans `text`, groupe `group` (0 = tout) ; `undefined` si aucun. Texte borné. */
export function regexExtract(text: string, pattern: string, group: number): string | undefined {
  const { re, maxSubject } = compileBoundedRegex(pattern);
  assertSubjectFits(text, maxSubject);
  const m = re.exec(text);
  if (m === null) return undefined;
  return m[group] ?? undefined;
}
