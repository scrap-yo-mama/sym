// SPDX-License-Identifier: AGPL-3.0-only
// Entrée du dossier d'enquête (tâche 2.14, 19c § 2, § 9.3) : taille, schéma fermé, secrets, puis normalisation et masquage
// AVANT tout stockage et tout LLM. Aucune troncature : un dossier trop gros est refusé avec `what_to_do`. Une erreur ne
// renvoie jamais la valeur fautive (nom de champ seulement) et ne crée rien.
//
// Normalisation (19c § 2, § 7) : couches 1 et 2 du masquage de 19 § 3 sur tout texte libre (`notes`, `sample`, `pitfall`,
// `tried.note`, `open_questions`), que `llm.redact` soit actif ou non ; chemin des URL en gabarit `{param}` (identifiants de
// personnes compris) ; valeurs de la liste d'exclusion `subject_exclusions` remplacées par un marqueur (indice
// `brief_subject_excluded`) ; `seen_at` futur ramené à la date de réception. Seul le dossier normalisé est conservé.
import { createHash } from 'node:crypto';
import { maskTextForLlm } from '../privacy/llm-mask.js';
import type { PersonalValueRegistry } from '../privacy/mask.js';
import { compileSchema } from '../schema/validator.js';
import { BRIEF_SCHEMA, type BriefErrorCode, type BriefHint, type BriefTry, type InvestigationBrief, DEFAULT_BRIEF_CONFIG } from './schema.js';
import { storageUrl, urlCarriesToken, urlsInText } from './url.js';

export type BriefRejection = {
  readonly ok: false;
  readonly code: BriefErrorCode;
  /** Champ fautif (`brief.hints.2.value`) ; jamais la valeur. */
  readonly field: string | null;
  readonly message: string;
  readonly what_to_do: string;
};
export type BriefAccepted = { readonly ok: true; readonly brief: InvestigationBrief; readonly bytes: number };

/** Conduites à tenir (texte pour le modèle, en anglais, 19c § 9.3). */
export function briefWhatToDo(code: BriefErrorCode, maxBytes = DEFAULT_BRIEF_CONFIG.maxBytes): string {
  switch (code) {
    case 'brief_too_large':
      return `Keep the highest-confidence hints and drop notes; resend under ${Math.floor(maxBytes / 1000)} KB.`;
    case 'secret_in_brief':
      return 'Remove cookies, Authorization headers, tokens and signed URLs from the brief, then resend it, or call again without brief. Nothing was kept.';
    case 'invalid_brief':
      return 'Remove or fix the named brief field (closed schema), or call again without brief.';
  }
}

const reject = (code: BriefErrorCode, field: string | null, message: string, maxBytes?: number): BriefRejection => ({ ok: false, code, field, message, what_to_do: briefWhatToDo(code, maxBytes) });

/** En-têtes et motifs d'identifiants (19c § 2) : cookie, `Authorization`, jetons de formats connus. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:set-)?cookie\s*:/i,
  /\b(?:proxy-)?authorization\s*:/i,
  /\bx-(?:api-key|auth-token|csrf-token|xsrf-token|amz-security-token)\s*:/i,
  /\bbearer\s+[A-Za-z0-9._~+/-]{8,}=*/i,
  /\bbasic\s+[A-Za-z0-9+/]{8,}={0,2}(?![A-Za-z0-9])/i,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}/,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9]{16,}/,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs])[-_][A-Za-z0-9_-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:PHPSESSID|JSESSIONID|ASP\.NET_SessionId|connect\.sid|sessionid|session_id|_session|sid)\s*=\s*[^\s;,&]{6,}/i,
];

/** Entropie de Shannon (bits par caractère). */
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** Jeton à forte entropie : 32 caractères au moins, trois classes (minuscules, majuscules, chiffres), entropie ≥ 4,2. */
function highEntropyToken(text: string): boolean {
  for (const m of text.matchAll(/[A-Za-z0-9_+/=-]{32,}/g)) {
    const t = m[0];
    if (!/[a-z]/.test(t) || !/[A-Z]/.test(t) || !/\d/.test(t)) continue;
    if (entropy(t) >= 4.2) return true;
  }
  return false;
}

/** Un texte porte-t-il un secret (en-tête, jeton connu ou à forte entropie, URL à jeton) ? */
export function textCarriesSecret(text: string, isUrlField = false): boolean {
  if (SECRET_PATTERNS.some((re) => re.test(text))) return true;
  if (highEntropyToken(text)) return true;
  if (isUrlField && urlCarriesToken(text.replace(/^[A-Z]{3,7}\s+/, ''))) return true;
  return urlsInText(text).some(urlCarriesToken);
}

/** Champs texte d'un dossier valide, avec leur chemin (sans la valeur dans les erreurs) et leur nature d'URL. */
function textFields(brief: InvestigationBrief): { path: string; text: string; url: boolean }[] {
  const out: { path: string; text: string; url: boolean }[] = [];
  if (brief.notes !== undefined) out.push({ path: 'brief.notes', text: brief.notes, url: false });
  (brief.hints ?? []).forEach((h, i) => {
    out.push({ path: `brief.hints.${i}.value`, text: h.value, url: h.kind === 'endpoint' || h.kind === 'example_url' });
    if (h.seen_on !== undefined) out.push({ path: `brief.hints.${i}.seen_on`, text: h.seen_on, url: true });
    if (h.sample !== undefined) out.push({ path: `brief.hints.${i}.sample`, text: h.sample, url: false });
  });
  (brief.tried ?? []).forEach((t, i) => {
    if (t.target !== undefined) out.push({ path: `brief.tried.${i}.target`, text: t.target, url: true });
    if (t.note !== undefined) out.push({ path: `brief.tried.${i}.note`, text: t.note, url: false });
  });
  (brief.open_questions ?? []).forEach((q, i) => out.push({ path: `brief.open_questions.${i}`, text: q, url: false }));
  return out;
}

/** Chemin d'erreur Ajv → `brief.hints.0.allowed_hosts` (caractères sûrs seulement). */
function fieldOf(error: { instancePath?: string; keyword?: string; params?: unknown } | undefined): string {
  if (error === undefined) return 'brief';
  const base = `brief${error.instancePath ?? ''}`.replace(/\//g, '.').replace(/[^a-zA-Z0-9_.]/g, '');
  if (error.keyword !== 'additionalProperties') return base.slice(0, 120);
  // Le nom d'une clé inconnue est choisi par l'appelant : renvoyé seulement s'il a l'allure d'un nom de champ, jamais d'un jeton.
  const name = String((error.params as { additionalProperty?: unknown }).additionalProperty ?? '');
  const safe = /^[a-z_]{1,32}$/.test(name) && !textCarriesSecret(name);
  return `${base}.${safe ? name : '<unknown>'}`.slice(0, 120);
}

/**
 * Contrôle d'un dossier reçu (19c § 9.3), dans l'ordre : taille (`brief_too_large`, jamais de troncature), schéma fermé
 * (`invalid_brief` nommant le champ), secrets (`secret_in_brief`, rien conservé ni renvoyé).
 */
export function checkBrief(raw: unknown, options: { readonly maxBytes?: number } = {}): BriefAccepted | BriefRejection {
  const maxBytes = options.maxBytes ?? DEFAULT_BRIEF_CONFIG.maxBytes;
  let serialized: string;
  try {
    serialized = JSON.stringify(raw) ?? 'null';
  } catch {
    return reject('invalid_brief', 'brief', 'dossier illisible');
  }
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > maxBytes) return reject('brief_too_large', 'brief', `dossier de plus de ${maxBytes} octets (aucune troncature)`, maxBytes);
  const validate = compileSchema(BRIEF_SCHEMA);
  if (!validate(raw)) {
    const field = fieldOf(validate.errors?.[0]);
    return reject('invalid_brief', field, `champ ${field} refusé (schéma fermé du dossier d’enquête)`);
  }
  const brief = raw as InvestigationBrief;
  for (const f of textFields(brief)) {
    if (textCarriesSecret(f.text, f.url)) return reject('secret_in_brief', f.path, `identifiant ou jeton dans ${f.path} : rien n’a été conservé`);
  }
  return { ok: true, brief, bytes };
}

export type BriefNormalizeOptions = {
  /** Date de réception : borne des `seen_at` futurs. */
  readonly receivedAt: Date;
  /** Couche 1 (registre des valeurs `x-personal` connues), facultative. */
  readonly registry?: PersonalValueRegistry;
  /** Liste d'exclusion hachée (`subject_exclusions`) : une valeur qui y figure est remplacée par un marqueur. */
  readonly isExcluded?: (value: string) => boolean;
};

export type NormalizedBrief = {
  readonly brief: InvestigationBrief;
  /** Indices dont une valeur figurait dans la liste d'exclusion (`brief_subject_excluded`). */
  readonly subjectExcluded: readonly string[];
  readonly sha256: string;
  readonly bytes: number;
};

export const BRIEF_SUBJECT_MARKER = '[excluded]';

/** Candidats à la liste d'exclusion dans un texte : e-mails, téléphones, segments de personne, texte entier. */
function subjectCandidates(text: string): string[] {
  const out = new Set<string>([text.trim()]);
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g)) out.add(m[0]);
  for (const m of text.matchAll(/(?:\+|00)?\d[\d ().-]{7,18}\d/g)) out.add(m[0]);
  for (const m of text.matchAll(/\/(?:in|u|user|users|profile|people)\/([^/?#\s]+)/gi)) {
    try {
      out.add(decodeURIComponent(m[1]!).replace(/[-_.]+/g, ' '));
    } catch {
      out.add(m[1]!);
    }
  }
  // Noms dans un texte libre : suites de 2 à 4 mots (la liste d'exclusion est hachée : on ne peut que tester des candidats).
  const words = text.split(/[\s,;:()"«»]+/).filter((w) => w !== '').slice(0, 600);
  for (let n = 2; n <= 4; n += 1) for (let i = 0; i + n <= words.length; i += 1) out.add(words.slice(i, i + n).join(' '));
  return [...out].filter((v) => v.length >= 3);
}

/** Texte masqué : liste d'exclusion d'abord (marqueur), puis couches 1 et 2. */
function maskText(text: string, opts: BriefNormalizeOptions, hit: () => void): string {
  let out = text;
  if (opts.isExcluded !== undefined) {
    for (const candidate of subjectCandidates(text)) {
      if (!opts.isExcluded(candidate)) continue;
      hit();
      out = out.split(candidate).join(BRIEF_SUBJECT_MARKER);
    }
  }
  return maskTextForLlm(out, opts.registry);
}

/** URL masquée : chemin en gabarit, valeurs de requête masquées (couche 2), exclusions remplacées. */
function maskUrl(raw: string, opts: BriefNormalizeOptions, hit: () => void): string {
  const prefix = /^([A-Z]{3,7})\s+/.exec(raw);
  const body = prefix === null ? raw : raw.slice(prefix[0].length);
  let out: string;
  try {
    const url = new URL(storageUrl(body.startsWith('/') && !body.startsWith('//') ? `https://zz-brief.invalid${body}` : body));
    if (opts.isExcluded !== undefined && subjectCandidates(body).some((c) => c !== body.trim() && opts.isExcluded!(c))) hit();
    for (const [k, v] of [...url.searchParams.entries()]) url.searchParams.set(k, maskText(v, opts, hit));
    const text = url.href.replace(/%7B([A-Za-z0-9_]{1,32})%7D/g, '{$1}');
    out = body.startsWith('/') && !body.startsWith('//') ? text.replace('https://zz-brief.invalid', '') : text;
  } catch {
    out = maskText(body, opts, hit);
  }
  return prefix === null ? out : `${prefix[1]} ${out}`;
}

/** `seen_at` lu : date valide, jamais dans le futur (ramenée à la réception). */
export function clampSeenAt(seenAt: string | undefined, receivedAt: Date): string | undefined {
  if (seenAt === undefined) return undefined;
  const t = Date.parse(seenAt);
  if (!Number.isFinite(t)) return undefined;
  return new Date(Math.min(t, receivedAt.getTime())).toISOString();
}

/** Empreinte stable du dossier normalisé (clés triées). */
export function briefSha256(brief: InvestigationBrief): string {
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
  return createHash('sha256').update(JSON.stringify(canon(brief))).digest('hex');
}

/**
 * Dossier normalisé et masqué (19c § 2) : seul ce dossier est conservé et envoyé au LLM. `notes`, `sample`, `pitfall`,
 * `tried.note` et `open_questions` : couches 1 et 2 ; URL (`endpoint`, `example_url`, `seen_on`, `tried.target`) : chemin en
 * gabarit et valeurs masquées ; aucune autre transformation (le dossier reste celui de l'IA).
 */
export function normalizeBrief(brief: InvestigationBrief, opts: BriefNormalizeOptions): NormalizedBrief {
  const excluded = new Set<string>();
  const hints: BriefHint[] = (brief.hints ?? []).map((h) => {
    const hit = () => excluded.add(h.id);
    const isUrl = h.kind === 'endpoint' || h.kind === 'example_url';
    const seenAt = clampSeenAt(h.seen_at, opts.receivedAt);
    return {
      id: h.id,
      kind: h.kind,
      value: isUrl ? maskUrl(h.value, opts, hit) : maskText(h.value, opts, hit),
      ...(h.seen === undefined ? {} : { seen: h.seen }),
      ...(h.seen_on === undefined ? {} : { seen_on: maskUrl(h.seen_on, opts, hit) }),
      ...(seenAt === undefined ? {} : { seen_at: seenAt }),
      ...(h.confidence === undefined ? {} : { confidence: h.confidence }),
      ...(h.sample === undefined ? {} : { sample: maskText(h.sample, opts, hit) }),
    };
  });
  const noop = () => undefined;
  const tried: BriefTry[] = (brief.tried ?? []).map((t) => ({
    approach: t.approach,
    outcome: t.outcome,
    ...(t.target === undefined ? {} : { target: maskUrl(t.target, opts, noop) }),
    ...(t.note === undefined ? {} : { note: maskText(t.note, opts, noop) }),
  }));
  const out: InvestigationBrief = {
    v: 1,
    ...(brief.notes === undefined ? {} : { notes: maskText(brief.notes, opts, noop) }),
    ...(hints.length === 0 ? {} : { hints }),
    ...(tried.length === 0 ? {} : { tried }),
    ...(brief.open_questions === undefined || brief.open_questions.length === 0 ? {} : { open_questions: brief.open_questions.map((q) => maskText(q, opts, noop)) }),
  };
  return { brief: out, subjectExcluded: [...excluded], sha256: briefSha256(out), bytes: Buffer.byteLength(JSON.stringify(out), 'utf8') };
}
