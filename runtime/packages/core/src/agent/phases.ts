// SPDX-License-Identifier: AGPL-3.0-only
// Règle des deux par phase (tâche 2.12, 19 §7, r6 R1, R3 à R6) : dans chaque phase, au plus deux des trois jambes
// (A entrée non fiable, B données privées, C sortie), les jambes partielles réduites par du code. Le registre d'outils de
// chaque phase est CONSTRUIT PAR LE CODE à partir de cette table (aucune phase par défaut, aucun pont MCP en V1 : MCP dans
// l'agent est en V1.1, interdit par construction avec session, en tunnel ou en agent instruit). La politique de requêtes
// de l'agent (r6 R4) est ici en logique pure ; l'agent réel s'y branche en 2.13 (vérifié aussi en 4.3).
import { registrableDomain } from '../pacing/domain.js';
import { normalizeSubjectValue } from '../privacy/subject.js';
import { AGENT_TOOLS, type AgentToolName } from './tools.js';

export const AGENT_PHASES = ['replay', 'e4_extract', 'investigation', 'e5_e6', 'step_repair', 'instructed', 'recompile', 'judge', 'reflect'] as const;
export type AgentPhase = (typeof AGENT_PHASES)[number];

export type PhaseRegistry = {
  readonly phase: AgentPhase;
  /** Outils offerts au modèle (liste fermée d'`AGENT_TOOLS`, figée). */
  readonly tools: readonly AgentToolName[];
  /** Aucun pont MCP en V1 (r6 R11 à R20 : V1.1). */
  readonly mcp: false;
  /** Un LLM intervient-il dans la phase ? */
  readonly llm: boolean;
  /** Jambe A : contenu non fiable en entrée. */
  readonly untrusted: boolean;
  /** Jambe B : `full` page connectée (session, tunnel) ; `reduced` valeurs du même domaine, structure des autres. */
  readonly private: 'none' | 'reduced' | 'full';
  /** Jambe C : `declared` requêtes déclarées (rejeu), `bounded` domaine cible et paramètres bornés, `none` aucun outil. */
  readonly output: 'none' | 'declared' | 'bounded';
  /** Mémoire du catalogue reçue. */
  readonly memory: 'none' | 'filtered' | 'structural';
};

export type PhaseContext = { readonly session?: boolean; readonly tunnel?: boolean };

const NAV_TOOLS: readonly AgentToolName[] = AGENT_TOOLS;

/** Registre de la phase : construit depuis la table de 19 §7 ; une phase inconnue lève (jamais de registre par défaut). */
export function toolRegistryForPhase(phase: AgentPhase, ctx: PhaseContext = {}): PhaseRegistry {
  const connected = ctx.session === true || ctx.tunnel === true;
  const make = (r: Omit<PhaseRegistry, 'phase' | 'mcp' | 'tools'> & { tools: readonly AgentToolName[] }): PhaseRegistry =>
    Object.freeze({ phase, mcp: false as const, ...r, tools: Object.freeze([...r.tools]) });
  switch (phase) {
    case 'replay':
      // Frontière : jamais de LLM, jamais de mémoire ; requêtes déclarées.
      return make({ tools: [], llm: false, untrusted: false, private: connected ? 'full' : 'none', output: 'declared', memory: 'none' });
    case 'e4_extract':
      // LLM en quarantaine : page et schéma, aucun outil (assert_e4_no_tools).
      return make({ tools: [], llm: true, untrusted: true, private: 'none', output: 'none', memory: 'none' });
    case 'investigation':
    case 'recompile':
    case 'e5_e6':
    case 'step_repair':
      // Sans session : mémoire filtrée (valeurs du même domaine). Avec session ou en tunnel : page connectée (B complet),
      // sortie bornée au domaine cible, écriture interdite par défaut, mémoire structurelle, reprise au niveau 1 (2.13).
      return make({
        tools: phase === 'investigation' || phase === 'recompile' ? [] : NAV_TOOLS,
        llm: true,
        untrusted: true,
        private: connected ? 'full' : 'reduced',
        output: 'bounded',
        memory: connected ? 'structural' : 'filtered',
      });
    case 'instructed':
      return make({ tools: NAV_TOOLS, llm: true, untrusted: true, private: connected ? 'full' : 'reduced', output: 'bounded', memory: 'structural' });
    case 'judge':
    case 'reflect':
      // Items et résumés masqués, aucun outil, sortie validée par Ajv, consultative.
      return make({ tools: [], llm: true, untrusted: true, private: 'reduced', output: 'none', memory: 'none' });
    default:
      throw new Error(`phase inconnue : ${String(phase)}`);
  }
}

/** Un outil n'est permis que s'il figure au registre de la phase (liste fermée construite par le code) ; `read_skill` (lecture de règles, sans réseau) n'en fait pas partie. */
export function phaseAllowsTool(registry: PhaseRegistry, tool: string): boolean {
  return (registry.tools as readonly string[]).includes(tool);
}

/** Jambes COMPLÈTES de la règle des deux : une jambe partielle (réduite par du code) ne compte pas. */
export function legsOf(reg: PhaseRegistry): { readonly A: boolean; readonly B: boolean; readonly C: boolean } {
  // C complète : sortie libre (outil de requête arbitraire, MCP) ; `bounded` et `declared` sont réduites par le code.
  return { A: reg.untrusted, B: reg.private === 'full', C: reg.mcp };
}

// --- Politique de requêtes de l'agent (r6 R4) -----------------------------------------------------------------------

export type AgentRequestContext = {
  /** Hôtes de l'API et suffixes de site (verrou de domaine). */
  readonly targetHosts: readonly string[];
  readonly targetSuffixes: readonly string[];
  /** URL vues dans le DOM et dans le trafic du run, et gabarits déclarés par la stratégie (`{param}`). */
  readonly domUrls: readonly string[];
  readonly trafficUrls: readonly string[];
  readonly templates: readonly string[];
  /** Entrées du run : seules valeurs admises vers le domaine cible. */
  readonly runInputs: Readonly<Record<string, unknown>>;
  /** Valeurs sensibles connues (mémoire, items d'autres API, secrets) : jamais dans une URL ni un corps. */
  readonly sensitiveValues: readonly string[];
  /** Valeurs de confiance supplémentaires (texte de la consigne du propriétaire de l'API) : admises comme valeur de paramètre. */
  readonly trustedValues?: readonly string[];
  readonly maxParams?: number;
  readonly maxParamLength?: number;
};

export type AgentRequestDecision = { readonly allowed: true } | { readonly allowed: false; readonly code: 'agent_request_blocked'; readonly reason: string };

const blocked = (reason: string): AgentRequestDecision => ({ allowed: false, code: 'agent_request_blocked', reason });

function hostAllowed(host: string, ctx: AgentRequestContext): boolean {
  const h = host.toLowerCase();
  if (ctx.targetHosts.some((t) => t.toLowerCase() === h)) return true;
  return ctx.targetSuffixes.some((s) => h === s.toLowerCase() || h.endsWith(`.${s.toLowerCase()}`));
}

const withoutQuery = (u: URL) => `${u.origin}${u.pathname}`;

const PLACEHOLDER = /\{[A-Za-z0-9_]+\}/g;
const ZZ = 'ZZPARAM';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeDecode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Le gabarit déclare-t-il au moins un emplacement `{param}` ? (Une URL littérale est une URL connue, pas un gabarit.) */
export const isUrlTemplate = (url: string): boolean => /\{[A-Za-z0-9_]+\}/.test(url);

/** Valeur posée dans une URL à la place d'un emplacement `{param}` (`free`), ou valeur d'une clé non variable du gabarit. */
type TemplateSlot = { readonly key: string; readonly value: string; readonly free: boolean };

/** Correspondance structurelle (origine, chemin, clés déclarées) ; renvoie les valeurs à contrôler, ou `null`. */
function matchTemplate(u: URL, template: string): TemplateSlot[] | null {
  let t: URL;
  try {
    t = new URL(template.replace(PLACEHOLDER, ZZ));
  } catch {
    return null;
  }
  const pathRe = new RegExp(`^${t.pathname.split(ZZ).map(escapeRe).join('([^/]+)')}$`);
  const pathMatch = pathRe.exec(u.pathname);
  if (t.origin !== u.origin || pathMatch === null) return null;
  const slots: TemplateSlot[] = pathMatch.slice(1).map((v) => ({ key: '', value: safeDecode(v), free: true }));
  for (const [key, value] of u.searchParams.entries()) {
    const declared = t.searchParams.getAll(key);
    if (declared.length === 0) return null;
    let matched = false;
    for (const tv of declared) {
      if (!tv.includes(ZZ)) {
        if (tv === value) matched = true;
        continue;
      }
      const m = new RegExp(`^${tv.split(ZZ).map(escapeRe).join('(.+?)')}$`).exec(value);
      if (m !== null) {
        for (const g of m.slice(1)) slots.push({ key, value: g, free: true });
        matched = true;
        break;
      }
    }
    if (!matched) slots.push({ key, value, free: false });
  }
  return slots;
}

/** Textes à confronter aux valeurs sensibles : forme brute, décodée (`+` compris comme espace), champs normalisés, chiffres seuls. */
function haystacks(raw: string, query: string): { readonly texts: string[]; readonly digits: string[] } {
  const texts = new Set<string>([raw, safeDecode(raw), safeDecode(raw.replace(/\+/g, ' '))]);
  const digits = new Set<string>();
  const fields = raw.split(/[?&#=/;,]/).map((p) => safeDecode(p.replace(/\+/g, ' ')));
  let values: string[] = [];
  try {
    values = [...new URLSearchParams(query).values()];
  } catch {
    // Requête illisible : champs seulement.
  }
  fields.push(values.join(''), values.join(' '));
  for (const f of fields) {
    if (f === '') continue;
    texts.add(f);
    texts.add(normalizeSubjectValue(f));
    const d = f.replace(/\D/g, '');
    if (d.length >= 9) digits.add(d);
  }
  return { texts: [...texts].map((t) => t.toLowerCase()), digits: [...digits] };
}

function hasSensitiveValue(hay: { readonly texts: readonly string[]; readonly digits: readonly string[] }, sensitive: readonly string[], inputs: ReadonlySet<string>): boolean {
  for (const value of sensitive) {
    const v = value.trim().toLowerCase();
    if (v.length < 3 || inputs.has(v)) continue;
    if (hay.texts.some((t) => t.includes(v))) return true;
    // Téléphone (E.164 normalisé) écrit à la française, avec points ou espaces : comparaison par chiffres, sur les 9 derniers.
    if (/^\+\d{8,15}$/.test(v) && hay.digits.some((d) => d.includes(v.slice(-9)))) return true;
  }
  return false;
}

const inputSet = (runInputs: AgentRequestContext['runInputs']): Set<string> =>
  new Set(Object.values(runInputs).filter((v): v is string | number => typeof v === 'string' || typeof v === 'number').map((v) => String(v).toLowerCase()));

/** Valeur sensible (mémoire, autres items, secrets) dans le corps d'une écriture (form-urlencoded, JSON, texte) : PA-01, « jamais dans une URL ni un corps ». */
export function bodyHasSensitiveValue(body: string, sensitiveValues: readonly string[], runInputs: AgentRequestContext['runInputs']): boolean {
  return hasSensitiveValue(haystacks(body, body), sensitiveValues, inputSet(runInputs));
}

/**
 * Une requête de l'agent n'est permise que si : GET (aucun corps), hôte dans le domaine cible, URL venue du DOM ou du
 * trafic du run (à l'identique, ou mêmes paramètres) ou d'un gabarit `{param}` déclaré, paramètres plafonnés en nombre et
 * en taille, aucune valeur sensible (mémoire, autres items, secrets ; `+` lu comme espace, valeurs normalisées) dans l'URL,
 * sauf une entrée du run vers le domaine cible, et chaque valeur de paramètre de confiance (PA-09) : même clé et même valeur
 * qu'une URL connue, entrée du run, mot de la consigne, nombre ; dans un gabarit, seul un emplacement `{param}` admet une
 * entrée du run ou un nombre. Une URL littérale (départ, `goto`) est une URL connue, jamais un gabarit.
 */
export function agentRequestPolicy(req: { readonly method: string; readonly url: string; readonly body?: string }, ctx: AgentRequestContext): AgentRequestDecision {
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    return blocked('url_invalid');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return blocked('scheme_not_allowed');
  if (u.username !== '' || u.password !== '') return blocked('credentials_in_url');
  if (!hostAllowed(u.hostname, ctx)) return blocked('host_not_allowed');
  if (req.method.toUpperCase() !== 'GET' || (req.body !== undefined && req.body !== '')) return blocked('method_not_allowed');
  const maxParams = ctx.maxParams ?? 10;
  const maxLen = ctx.maxParamLength ?? 200;
  const params = [...u.searchParams.entries()];
  if (params.length > maxParams) return blocked('too_many_params');
  if (params.some(([k, v]) => k.length > 64 || v.length > maxLen)) return blocked('param_too_long');
  const inputs = inputSet(ctx.runInputs);
  if (hasSensitiveValue(haystacks(req.url, u.search), ctx.sensitiveValues, inputs)) return blocked('sensitive_value');
  const known = [...ctx.domUrls, ...ctx.trafficUrls];
  const fromPage = known.some((k) => {
    try {
      const ku = new URL(k);
      return ku.href === u.href || (withoutQuery(ku) === withoutQuery(u) && [...u.searchParams.keys()].every((p) => ku.searchParams.has(p)));
    } catch {
      return false;
    }
  });
  const matches = ctx.templates.flatMap((t) => {
    const slots = matchTemplate(u, t);
    return slots === null ? [] : [slots];
  });
  if (!fromPage && matches.length === 0) return blocked('url_not_from_page');
  const trusted = new Set((ctx.trustedValues ?? []).map((v) => v.toLowerCase()));
  const sameKnown = known.flatMap((k) => {
    try {
      const ku = new URL(k);
      return withoutQuery(ku) === withoutQuery(u) ? [ku] : [];
    } catch {
      return [];
    }
  });
  const numeric = (value: string) => /^\d{1,12}$/.test(value);
  const trustedValue = (key: string, value: string): boolean =>
    numeric(value) || inputs.has(value.toLowerCase()) || trusted.has(value.toLowerCase()) || sameKnown.some((ku) => ku.searchParams.getAll(key).includes(value));
  const knownOk = fromPage && params.every(([key, value]) => trustedValue(key, value));
  const templateOk = matches.some((slots) => slots.every((s) => (s.free ? numeric(s.value) || inputs.has(s.value.toLowerCase()) : trustedValue(s.key, s.value))));
  if (!knownOk && !templateOk) return blocked('param_value_untrusted');
  return { allowed: true };
}

/** Domaine enregistrable d'un hôte (aide aux appelants qui posent `targetSuffixes`). */
export const targetSuffixOf = (host: string): string => registrableDomain(host);
