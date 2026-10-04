// SPDX-License-Identifier: AGPL-3.0-only
// Spécifications des stratégies agentiques (tâche 2.4 ; 04 §3.1 ; 04b §1 `StrategyVersion.spec`) :
// - E4 `agent_fetch` : page obtenue comme en E1 (`fetch`) ou E2 (`fetch_in_page`), mise en forme par le LLM (rôle `extract`) ;
// - E5 `hybrid` : script DÉCLARATIF (liste fermée d'étapes, aucun code généré) dont certaines étapes sont déléguées à
//   l'agent (`agent`), extraction par libellés (sans LLM) ou déléguée (rôle `extract`) ;
// - E6 `agent` : l'agent pilote le navigateur de bout en bout (`AgentEngine`, ADR 0001), limité au serveur (0.6b).
// Données, pas code : chaque document est validé ici (types, bornes, domaines de l'API) avant toute exécution. Les URL
// sont http(s), sans identifiants, sur un hôte de `allowed_hosts` (INV10, 08 §4 mesure 2). Aucun secret, aucune session.
import { DslError } from '../dsl/errors.js';
import { compileOperators, type CompiledOperator } from '../dsl/operators.js';

const HOST_RE = /^[a-z0-9_.-]{1,253}$/;
const MAX_INSTRUCTION = 2000;
const MAX_NAME = 300;
const MAX_STEPS = 50;
const MAX_FIELDS = 64;
const MAX_LABEL = 80;

/** Rôles ARIA qu'une étape `click` peut viser : éléments interactifs seulement. */
export const HYBRID_CLICK_ROLES = Object.freeze(['link', 'button', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'treeitem'] as const);
export type HybridClickRole = (typeof HYBRID_CLICK_ROLES)[number];

/**
 * Règles Markdown EMBARQUÉES dans un prompt figé E4-E6 (tâche 2.10, 18 §4.5) : RÉFÉRENCES seulement (`nom@version#sha256`)
 * des règles appliquées à la compilation (`RULES_MAX_TOKENS` de 1 000), avec leur niveau, et des skills listés (E6). Le
 * texte n'est jamais stocké dans la spec (lisible des membres d'une API partagée d'instance, INV12) : au run, il est relu
 * dans `rule_file_versions` sous l'identité du propriétaire et vérifié par `sha256` ; le run ne lit jamais les règles
 * COURANTES. Aucun texte injecté en cas d'écart.
 */
export type EmbeddedRuleRef = { readonly ref: string; readonly level: 'instance' | 'domain' | 'api' };
export type EmbeddedSkillRef = { readonly ref: string; readonly described: boolean };
export type EmbeddedRules = { readonly rules: readonly EmbeddedRuleRef[]; readonly skills: readonly EmbeddedSkillRef[] };
/** `nom@version#sha256`. */
export const EMBEDDED_REF_RE = /^([a-z0-9-]{1,64})@([1-9][0-9]{0,8})#([0-9a-f]{64})$/;
const EMBEDDED_LEVELS = new Set(['instance', 'domain', 'api']);
/** Empreinte de compilation d'une étape E5 (19 §4, 19b §1) : règles `nom@version#sha256`, modèle, date. */
export type CompiledWith = { readonly rules: readonly string[]; readonly model_id: string | null; readonly at: string };

export type AgentFetchSpec = {
  readonly schema_version: 1;
  readonly kind: 'agent_fetch';
  /** Page source : GET, sans en-tête d'authentification ni cookie (INV8, 08 §4 mesure 5). */
  readonly request: { readonly url: string; readonly allowed_hosts: readonly string[] };
  /** E1 (couche réseau) ou E2 (navigateur ouvert sur le site). */
  readonly via: 'fetch' | 'fetch_in_page';
  /** Consigne d'extraction ; la page n'est JAMAIS une instruction (08 §4 mesure 1). */
  readonly instruction: string;
  /**
   * `sample_items` (essai d'enquête seulement, banc R06 et R08) : le modèle ne rend que les N premiers éléments de la page,
   * sur une entrée bornée (`E4_SAMPLE_INPUT_CHARS`) ; la stratégie compilée lit ensuite tout sans LLM. Absent : extraction
   * complète (version E4 retenue, rejeu).
   */
  readonly limits: { readonly max_response_bytes: number; readonly max_input_chars: number; readonly timeout_ms: number; readonly sample_items?: number };
  readonly rules?: EmbeddedRules;
};

/** Éléments au plus d'un essai E4 d'enquête (échantillon des premiers éléments de la page 1 ; banc R06 et R08). */
export const E4_SAMPLE_ITEMS = 20;
/** Caractères de texte visible au plus envoyés au modèle par un essai E4 en échantillon. */
export const E4_SAMPLE_INPUT_CHARS = 24_000;
/** Jetons de sortie permis à un appel E4 : échantillon, ou extraction complète (le plafond de l'essai les compte avant l'envoi). */
export const E4_SAMPLE_MAX_TOKENS = 4_096;
export const E4_FULL_MAX_TOKENS = 8_192;

export type AgentSpec = {
  readonly schema_version: 1;
  readonly kind: 'agent';
  readonly start_url: string;
  readonly allowed_hosts: readonly string[];
  readonly instruction: string;
  readonly limits: { readonly max_steps: number; readonly timeout_ms: number };
  readonly rules?: EmbeddedRules;
};

export type HybridTarget = { readonly role: HybridClickRole; readonly name: string };

export type HybridStep = (
  | { readonly op: 'goto'; readonly url: string }
  | { readonly op: 'click'; readonly target: HybridTarget }
  | { readonly op: 'scroll'; readonly direction: 'up' | 'down' }
  | { readonly op: 'wait'; readonly ms: number }
  /** Étape déléguée à l'agent (E5 « script + agent ») : LLM à chaque run. */
  | { readonly op: 'agent'; readonly instruction: string }
) & { readonly compiled_with?: CompiledWith };

/** Localisation d'un champ sans LLM : ligne « libellé : valeur » unique de la page, ou premier titre de niveau donné. */
export type FieldLocator =
  | { readonly label: string; readonly ops: readonly unknown[] }
  | { readonly heading: 1 | 2 | 3 | 4 | 5 | 6; readonly ops: readonly unknown[] };

export type HybridExtract =
  /** Un enregistrement par run, extrait par libellés (aucun LLM). */
  | { readonly mode: 'labels'; readonly fields: Readonly<Record<string, FieldLocator>> }
  /** Extraction déléguée au LLM (rôle `extract`) sur le texte de la page finale. */
  | { readonly mode: 'agent'; readonly instruction: string };

export type HybridSpec = {
  readonly schema_version: 1;
  readonly kind: 'hybrid';
  readonly start_url: string;
  readonly allowed_hosts: readonly string[];
  readonly steps: readonly HybridStep[];
  readonly extract: HybridExtract;
  readonly limits: { readonly timeout_ms: number; readonly step_timeout_ms: number; readonly max_input_chars: number };
  /** Origine d'une stratégie compilée depuis une trace E6 (04 §3.1) : version E6 et moteur. */
  readonly compiled_from?: { readonly execution: 'agent'; readonly version: number | null; readonly engine: string };
};

export type SpecCheck<T> = { readonly ok: true; readonly spec: T } | { readonly ok: false; readonly errors: readonly string[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

class Checker {
  readonly errors: string[] = [];
  fail(path: string, message: string): void {
    if (this.errors.length < 20) this.errors.push(`${path} : ${message}`);
  }
  str(v: unknown, path: string, max: number): string {
    if (typeof v !== 'string' || v.trim() === '' || v.length > max) {
      this.fail(path, `chaîne non vide de ${max} caractères au plus attendue`);
      return '';
    }
    return v;
  }
  int(v: unknown, path: string, min: number, max: number, fallback: number): number {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      this.fail(path, `entier entre ${min} et ${max} attendu`);
      return fallback;
    }
    return v;
  }
  hosts(v: unknown, path: string): string[] {
    if (!Array.isArray(v) || v.length === 0 || v.length > 10 || !v.every((h) => typeof h === 'string' && HOST_RE.test(h))) {
      this.fail(path, 'liste de 1 à 10 noms d’hôte attendue');
      return [];
    }
    return v.map((h: string) => h.toLowerCase());
  }
  url(v: unknown, path: string, hosts: readonly string[]): string {
    if (typeof v !== 'string' || v.length > 2048) {
      this.fail(path, 'URL attendue');
      return '';
    }
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      this.fail(path, 'URL illisible');
      return '';
    }
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username !== '' || u.password !== '') {
      this.fail(path, 'http(s) sans identifiants attendu');
      return '';
    }
    if (!hosts.includes(u.hostname.toLowerCase())) this.fail(path, 'hôte hors des domaines de l’API');
    return u.href;
  }
  version(spec: Record<string, unknown>, kind: string): void {
    if (spec['schema_version'] !== 1) this.fail('schema_version', '1 attendu');
    if (spec['kind'] !== kind) this.fail('kind', `« ${kind} » attendu`);
  }
  rules(v: unknown, path: string): EmbeddedRules | undefined {
    if (v === undefined) return undefined;
    const r = isRecord(v) ? v : {};
    for (const key of Object.keys(r)) if (key !== 'rules' && key !== 'skills') this.fail(`${path}.${key}`, 'champ non autorisé (références seulement, jamais le texte)');
    const list = <T>(raw: unknown, at: string, max: number, keys: readonly string[], item: (o: Record<string, unknown>) => T | null): T[] => {
      if (!Array.isArray(raw) || raw.length > max) {
        this.fail(at, `liste de ${max} références au plus attendue`);
        return [];
      }
      const out: T[] = [];
      for (const [i, x] of raw.entries()) {
        const o = isRecord(x) ? x : {};
        for (const key of Object.keys(o)) if (!keys.includes(key)) this.fail(`${at}[${i}].${key}`, 'champ non autorisé');
        const ref = o['ref'];
        if (typeof ref !== 'string' || !EMBEDDED_REF_RE.test(ref)) this.fail(`${at}[${i}].ref`, 'référence nom@version#sha256 attendue');
        const value = item(o);
        if (value === null) this.fail(`${at}[${i}]`, 'référence invalide');
        else out.push(value);
      }
      return out;
    };
    const rules = list(r['rules'], `${path}.rules`, 20, ['ref', 'level'], (o) =>
      typeof o['ref'] === 'string' && typeof o['level'] === 'string' && EMBEDDED_LEVELS.has(o['level']) ? { ref: o['ref'], level: o['level'] as EmbeddedRuleRef['level'] } : null,
    );
    const skills = list(r['skills'] ?? [], `${path}.skills`, 100, ['ref', 'described'], (o) => (typeof o['ref'] === 'string' && typeof o['described'] === 'boolean' ? { ref: o['ref'], described: o['described'] } : null));
    return { rules, skills };
  }
  compiledWith(v: unknown, path: string): CompiledWith | undefined {
    if (v === undefined) return undefined;
    const r = isRecord(v) ? v : {};
    for (const key of Object.keys(r)) if (!['rules', 'model_id', 'at'].includes(key)) this.fail(`${path}.${key}`, 'champ non autorisé');
    const rules = r['rules'];
    if (!Array.isArray(rules) || rules.length > 40 || !rules.every((x) => typeof x === 'string' && x.length <= 200)) this.fail(`${path}.rules`, 'liste de références nom@version#sha256 attendue');
    const model = r['model_id'];
    if (model !== null && (typeof model !== 'string' || model.length > 200)) this.fail(`${path}.model_id`, 'identifiant de modèle ou null attendu');
    const at = this.str(r['at'], `${path}.at`, 40);
    return { rules: Array.isArray(rules) ? (rules as string[]) : [], model_id: typeof model === 'string' ? model : null, at };
  }
  done<T>(spec: T): SpecCheck<T> {
    return this.errors.length === 0 ? { ok: true, spec } : { ok: false, errors: this.errors };
  }
}

/** Valide une stratégie E4 (`agent_fetch`) ; les défauts de `limits` sont posés ici. */
export function validateAgentFetchSpec(input: unknown): SpecCheck<AgentFetchSpec> {
  const c = new Checker();
  if (!isRecord(input)) return { ok: false, errors: ['spec : objet attendu'] };
  c.version(input, 'agent_fetch');
  const request = isRecord(input['request']) ? input['request'] : {};
  for (const key of Object.keys(request)) if (key !== 'url' && key !== 'allowed_hosts') c.fail(`request.${key}`, 'champ non autorisé (ni en-tête, ni session, ni corps)');
  const hosts = c.hosts(request['allowed_hosts'], 'request.allowed_hosts');
  const url = c.url(request['url'], 'request.url', hosts);
  const via = input['via'] ?? 'fetch';
  if (via !== 'fetch' && via !== 'fetch_in_page') c.fail('via', '« fetch » ou « fetch_in_page » attendu');
  const instruction = c.str(input['instruction'], 'instruction', MAX_INSTRUCTION);
  const limits = isRecord(input['limits']) ? input['limits'] : {};
  const rules = c.rules(input['rules'], 'rules');
  return c.done<AgentFetchSpec>({
    ...(rules === undefined ? {} : { rules }),
    schema_version: 1,
    kind: 'agent_fetch',
    request: { url, allowed_hosts: hosts },
    via: via as AgentFetchSpec['via'],
    instruction,
    limits: {
      max_response_bytes: c.int(limits['max_response_bytes'], 'limits.max_response_bytes', 1024, 20_000_000, 5_000_000),
      max_input_chars: c.int(limits['max_input_chars'], 'limits.max_input_chars', 500, 400_000, 60_000),
      timeout_ms: c.int(limits['timeout_ms'], 'limits.timeout_ms', 1000, 600_000, 120_000),
      ...(limits['sample_items'] === undefined ? {} : { sample_items: c.int(limits['sample_items'], 'limits.sample_items', 1, 100, E4_SAMPLE_ITEMS) }),
    },
  });
}

/** Valide une stratégie E6 (`agent`). */
export function validateAgentSpec(input: unknown): SpecCheck<AgentSpec> {
  const c = new Checker();
  if (!isRecord(input)) return { ok: false, errors: ['spec : objet attendu'] };
  c.version(input, 'agent');
  const hosts = c.hosts(input['allowed_hosts'], 'allowed_hosts');
  const start = c.url(input['start_url'], 'start_url', hosts);
  const instruction = c.str(input['instruction'], 'instruction', MAX_INSTRUCTION);
  const limits = isRecord(input['limits']) ? input['limits'] : {};
  const rules = c.rules(input['rules'], 'rules');
  return c.done<AgentSpec>({
    ...(rules === undefined ? {} : { rules }),
    schema_version: 1,
    kind: 'agent',
    start_url: start,
    allowed_hosts: hosts,
    instruction,
    limits: {
      max_steps: c.int(limits['max_steps'], 'limits.max_steps', 1, 100, 25),
      timeout_ms: c.int(limits['timeout_ms'], 'limits.timeout_ms', 1000, 1_800_000, 300_000),
    },
  });
}

function checkOps(c: Checker, ops: unknown, path: string): readonly unknown[] {
  if (ops === undefined) return [];
  if (!Array.isArray(ops)) {
    c.fail(path, 'liste d’opérateurs attendue');
    return [];
  }
  try {
    compileOperators(ops);
  } catch (error) {
    c.fail(path, error instanceof DslError ? error.message : 'opérateur invalide');
  }
  return ops;
}

function checkLocator(c: Checker, v: unknown, path: string): FieldLocator {
  if (!isRecord(v)) {
    c.fail(path, 'localisation attendue');
    return { label: '', ops: [] };
  }
  const ops = checkOps(c, v['ops'], `${path}.ops`);
  if ('label' in v) {
    for (const key of Object.keys(v)) if (key !== 'label' && key !== 'ops') c.fail(`${path}.${key}`, 'champ non autorisé');
    return { label: c.str(v['label'], `${path}.label`, MAX_LABEL), ops };
  }
  if ('heading' in v) {
    for (const key of Object.keys(v)) if (key !== 'heading' && key !== 'ops') c.fail(`${path}.${key}`, 'champ non autorisé');
    const level = c.int(v['heading'], `${path}.heading`, 1, 6, 1) as 1 | 2 | 3 | 4 | 5 | 6;
    return { heading: level, ops };
  }
  c.fail(path, '« label » ou « heading » attendu');
  return { label: '', ops: [] };
}

function checkStep(c: Checker, v: unknown, path: string, hosts: readonly string[]): HybridStep | null {
  if (!isRecord(v)) {
    c.fail(path, 'étape attendue');
    return null;
  }
  const allowKeys = (keys: readonly string[]) => {
    for (const key of Object.keys(v)) if (!keys.includes(key) && key !== 'compiled_with') c.fail(`${path}.${key}`, 'champ non autorisé');
  };
  const step = checkStepOp(c, v, path, hosts, allowKeys);
  const compiledWith = c.compiledWith(v['compiled_with'], `${path}.compiled_with`);
  return step === null || compiledWith === undefined ? step : { ...step, compiled_with: compiledWith };
}

function checkStepOp(c: Checker, v: Record<string, unknown>, path: string, hosts: readonly string[], allowKeys: (keys: readonly string[]) => void): HybridStep | null {
  switch (v['op']) {
    case 'goto':
      allowKeys(['op', 'url']);
      return { op: 'goto', url: c.url(v['url'], `${path}.url`, hosts) };
    case 'click': {
      allowKeys(['op', 'target']);
      const t = isRecord(v['target']) ? v['target'] : {};
      const role = t['role'];
      if (typeof role !== 'string' || !(HYBRID_CLICK_ROLES as readonly string[]).includes(role)) c.fail(`${path}.target.role`, 'rôle interactif attendu');
      return { op: 'click', target: { role: role as HybridClickRole, name: c.str(t['name'], `${path}.target.name`, MAX_NAME) } };
    }
    case 'scroll':
      allowKeys(['op', 'direction']);
      if (v['direction'] !== 'up' && v['direction'] !== 'down') c.fail(`${path}.direction`, '« up » ou « down » attendu');
      return { op: 'scroll', direction: v['direction'] === 'up' ? 'up' : 'down' };
    case 'wait':
      allowKeys(['op', 'ms']);
      return { op: 'wait', ms: c.int(v['ms'], `${path}.ms`, 0, 10_000, 0) };
    case 'agent':
      allowKeys(['op', 'instruction']);
      return { op: 'agent', instruction: c.str(v['instruction'], `${path}.instruction`, MAX_INSTRUCTION) };
    default:
      c.fail(`${path}.op`, 'étape hors de la liste fermée (goto, click, scroll, wait, agent)');
      return null;
  }
}

/** Valide une stratégie E5 (`hybrid`) : étapes en liste fermée, domaines de l'API, extraction bornée. */
export function validateHybridSpec(input: unknown): SpecCheck<HybridSpec> {
  const c = new Checker();
  if (!isRecord(input)) return { ok: false, errors: ['spec : objet attendu'] };
  c.version(input, 'hybrid');
  const hosts = c.hosts(input['allowed_hosts'], 'allowed_hosts');
  const start = c.url(input['start_url'], 'start_url', hosts);
  const rawSteps = input['steps'];
  const steps: HybridStep[] = [];
  if (!Array.isArray(rawSteps) || rawSteps.length > MAX_STEPS) c.fail('steps', `liste de ${MAX_STEPS} étapes au plus attendue`);
  else rawSteps.forEach((s, i) => {
    const step = checkStep(c, s, `steps[${i}]`, hosts);
    if (step !== null) steps.push(step);
  });
  const rawExtract = isRecord(input['extract']) ? input['extract'] : {};
  let extract: HybridExtract;
  if (rawExtract['mode'] === 'labels') {
    const rawFields = isRecord(rawExtract['fields']) ? rawExtract['fields'] : {};
    const names = Object.keys(rawFields);
    if (names.length === 0 || names.length > MAX_FIELDS) c.fail('extract.fields', `1 à ${MAX_FIELDS} champs attendus`);
    const fields: Record<string, FieldLocator> = {};
    for (const name of names) fields[name] = checkLocator(c, rawFields[name], `extract.fields.${name}`);
    extract = { mode: 'labels', fields };
  } else if (rawExtract['mode'] === 'agent') {
    extract = { mode: 'agent', instruction: c.str(rawExtract['instruction'], 'extract.instruction', MAX_INSTRUCTION) };
  } else {
    c.fail('extract.mode', '« labels » ou « agent » attendu');
    extract = { mode: 'labels', fields: {} };
  }
  const limits = isRecord(input['limits']) ? input['limits'] : {};
  const from = input['compiled_from'];
  let compiledFrom: HybridSpec['compiled_from'];
  if (from !== undefined) {
    const f = isRecord(from) ? from : {};
    if (f['execution'] !== 'agent') c.fail('compiled_from.execution', '« agent » attendu');
    const version = f['version'] === null ? null : c.int(f['version'], 'compiled_from.version', 1, 2 ** 31 - 1, 1);
    compiledFrom = { execution: 'agent', version, engine: c.str(f['engine'], 'compiled_from.engine', 80) };
  }
  return c.done<HybridSpec>({
    schema_version: 1,
    kind: 'hybrid',
    start_url: start,
    allowed_hosts: hosts,
    steps,
    extract,
    limits: {
      timeout_ms: c.int(limits['timeout_ms'], 'limits.timeout_ms', 1000, 1_800_000, 120_000),
      step_timeout_ms: c.int(limits['step_timeout_ms'], 'limits.step_timeout_ms', 500, 120_000, 15_000),
      max_input_chars: c.int(limits['max_input_chars'], 'limits.max_input_chars', 500, 400_000, 60_000),
    },
    ...(compiledFrom === undefined ? {} : { compiled_from: compiledFrom }),
  });
}

/**
 * Champs d'une extraction par libellés (sans LLM), validés comme ceux d'une stratégie `hybrid` : réutilisé par l'étape
 * `extract` du format `steps` (tâche 2.13).
 */
export function validateLabelFields(input: unknown): { ok: true; fields: Record<string, FieldLocator> } | { ok: false; errors: readonly string[] } {
  const c = new Checker();
  const raw = isRecord(input) ? input : {};
  const names = Object.keys(raw);
  if (!isRecord(input) || names.length === 0 || names.length > MAX_FIELDS) c.fail('fields', `1 à ${MAX_FIELDS} champs attendus`);
  const fields: Record<string, FieldLocator> = {};
  for (const name of names) fields[name] = checkLocator(c, raw[name], `fields.${name}`);
  return c.errors.length === 0 ? { ok: true, fields } : { ok: false, errors: c.errors };
}

/** Vrai si une stratégie E5 s'exécute sans aucun appel LLM (aucune étape ni extraction déléguée). */
export function hybridUsesLlm(spec: HybridSpec): boolean {
  return spec.extract.mode === 'agent' || spec.steps.some((s) => s.op === 'agent');
}

/** Opérateurs compilés d'une localisation (déjà validés par `validateHybridSpec`). */
export function locatorOperators(locator: FieldLocator): CompiledOperator[] {
  return compileOperators(locator.ops);
}
