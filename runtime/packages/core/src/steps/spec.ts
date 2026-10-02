// SPDX-License-Identifier: AGPL-3.0-only
// Format `kind: "steps"` des stratégies E5 (19 §4, 19b §1, tâche 2.13) : jeu d'opérations FERMÉ (`goto`, `click`, `type`,
// `select`, `scroll`, `wait_for`, `extract`) interprété dans le bac à sable (INV7) ; aucune expression, aucun code.
// - Le COMPILÉ (cette spec) porte `target` et `alternates` sémantiques (rôle + nom accessible, ou texte), `side_effect`
//   (calculé par le code : un `side_effect` déclaré plus faible que le calcul est relevé), `params` (entrées du run lues),
//   `agent_budget` et `compiled_with` (règles `nom@version#sha256` et modèle : rempli par 2.10 ; liste vide avant).
// - La SOURCE (`validateStepsSource`) porte `intent`, `pre` et `post[]`, marqués `derived_from_untrusted` et jamais lus
//   comme des règles. `post` est IMMUABLE en réparation (comme `output_schema`, INV1) : elle n'est pas dans le compilé,
//   aucun patch ne l'atteint.
// - `type` et `select` ne prennent qu'une ENTRÉE DU RUN (`value: { input: "nom" }`), jamais un texte libre.
// Les URL sont http(s), sans identifiants, sur un hôte de `allowed_hosts` (INV10).
import { validateLabelFields, type FieldLocator } from '../agent/specs.js';
import { computeSideEffect, maxSideEffect, STEP_SIDE_EFFECTS, type StepSideEffect } from './side-effect.js';
import { sanitizeStepIntent } from './intent.js';

export const STEP_OPS = ['goto', 'click', 'type', 'select', 'scroll', 'wait_for', 'extract'] as const;
export type StepOp = (typeof STEP_OPS)[number];

/** Rôles ARIA qu'une cible d'étape peut viser (interactifs, champs, repères de lecture pour `wait_for`). */
export const STEP_ROLES = Object.freeze([
  'link', 'button', 'tab', 'menuitem', 'option', 'checkbox', 'radio', 'switch', 'treeitem',
  'textbox', 'searchbox', 'combobox', 'listbox', 'spinbutton',
  'heading', 'region', 'main', 'navigation', 'list', 'listitem', 'table', 'row', 'cell', 'img', 'article', 'status',
] as const);
export type StepRole = (typeof STEP_ROLES)[number];

/** Défauts « à valider » de 19b §6 (banc 2.8). */
export const STEP_REPAIR_DEFAULTS = Object.freeze({
  /** `max_step_repairs_per_run` : au-delà, `step_cascade`. */
  maxStepRepairsPerRun: 2,
  /** Part d'étapes cassées au-delà de laquelle la reprise s'arrête aussi (à valider). */
  maxBrokenShare: 0.5,
  /** `agent_budget` par étape : 6 pas, 0,02 $. */
  agentBudget: Object.freeze({ max_steps: 6, max_usd: 0.02 }),
  /** N de V5 : rejeux de l'étape recompilée sans LLM. */
  llmFreeReplays: 2,
  /** K de l'agent instruit : tentative de compilation après K runs réussis. */
  instructedCompileAfter: 3,
});

export type StepAlternate = { readonly role: StepRole; readonly name: string } | { readonly text: string };
export type StepTarget = ({ readonly role: StepRole; readonly name: string } | { readonly text: string }) & { readonly alternates: readonly StepAlternate[] };
export type StepAgentBudget = { readonly max_steps: number; readonly max_usd: number };
export type CompiledWith = { readonly rules: readonly string[]; readonly model_id: string | null; readonly at: string | null };

export type StepDef = {
  readonly id: string;
  readonly op: StepOp;
  readonly target?: StepTarget;
  /** `goto` : URL sur les domaines de l'API. */
  readonly url?: string;
  /** `type`, `select` : nom d'une entrée du run. */
  readonly value?: { readonly input: string };
  /** `type`, `select` : l'élément est-il dans un `form` (vu à la compilation) ; absent : inconnu. */
  readonly form?: boolean;
  /** `scroll`. */
  readonly direction?: 'up' | 'down';
  /** `extract` : localisation des champs sans LLM (lignes « libellé : valeur », titres). */
  readonly fields?: Readonly<Record<string, FieldLocator>>;
  readonly side_effect: StepSideEffect;
  readonly params: readonly string[];
  readonly agent_budget: StepAgentBudget;
  readonly compiled_with: CompiledWith;
};

export type StepsSpec = {
  readonly schema_version: 1;
  readonly kind: 'steps';
  readonly start_url: string;
  readonly allowed_hosts: readonly string[];
  readonly steps: readonly StepDef[];
  readonly limits: { readonly timeout_ms: number; readonly step_timeout_ms: number; readonly max_input_chars: number };
  readonly compiled_from?: { readonly execution: 'agent'; readonly version: number | null; readonly engine: string };
};

/** Conditions d'une étape, en liste fermée (aucune expression), évaluées par l'hôte sur ses observations. */
export type StepPost =
  | { readonly kind: 'url_changed' }
  | { readonly kind: 'url_contains'; readonly value: string }
  | { readonly kind: 'element_present'; readonly role: StepRole; readonly name: string }
  | { readonly kind: 'element_absent'; readonly role: StepRole; readonly name: string }
  | { readonly kind: 'text_present'; readonly value: string };
export type StepPre = { readonly url_contains?: string; readonly element_present?: { readonly role: StepRole; readonly name: string } };

export type StepSource = {
  readonly id: string;
  /** Nettoyée (200 caractères) ; non fiable. */
  readonly intent: string;
  readonly pre: StepPre;
  readonly post: readonly StepPost[];
  readonly derived_from_untrusted: true;
};

export type StepsCheck<T> = { readonly ok: true; readonly spec: T } | { readonly ok: false; readonly errors: readonly string[] };

const HOST_RE = /^[a-z0-9_.-]{1,253}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const INPUT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const MAX_STEPS = 50;
const MAX_NAME = 300;
const MAX_ALTERNATES = 5;
const MAX_POST = 8;
const MAX_TEXT = 200;
const MAX_RULES = 50;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

class Checker {
  readonly errors: string[] = [];
  fail(path: string, message: string): void {
    if (this.errors.length < 30) this.errors.push(`${path} : ${message}`);
  }
  keys(v: Record<string, unknown>, path: string, allowed: readonly string[]): void {
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.fail(`${path}.${k}`, 'champ non autorisé');
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
  num(v: unknown, path: string, min: number, max: number, fallback: number): number {
    if (v === undefined) return fallback;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      this.fail(path, `nombre entre ${min} et ${max} attendu`);
      return fallback;
    }
    return v;
  }
  role(v: unknown, path: string): StepRole {
    if (typeof v !== 'string' || !(STEP_ROLES as readonly string[]).includes(v)) this.fail(path, 'rôle ARIA de la liste fermée attendu');
    return v as StepRole;
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
}

function checkSemantic(c: Checker, v: unknown, path: string): StepAlternate {
  if (!isRecord(v)) {
    c.fail(path, 'cible attendue');
    return { text: '' };
  }
  if ('text' in v) {
    c.keys(v, path, ['text']);
    return { text: c.str(v['text'], `${path}.text`, MAX_NAME) };
  }
  c.keys(v, path, ['role', 'name']);
  return { role: c.role(v['role'], `${path}.role`), name: c.str(v['name'], `${path}.name`, MAX_NAME).replace(/\s+/g, ' ').trim() };
}

function checkTarget(c: Checker, v: unknown, path: string): StepTarget {
  if (!isRecord(v)) {
    c.fail(path, 'cible attendue (rôle + nom, ou texte)');
    return { text: '', alternates: [] };
  }
  const { alternates: rawAlt, ...main } = v;
  const head = checkSemantic(c, main, path);
  const alternates: StepAlternate[] = [];
  if (rawAlt !== undefined) {
    if (!Array.isArray(rawAlt) || rawAlt.length > MAX_ALTERNATES) c.fail(`${path}.alternates`, `liste de ${MAX_ALTERNATES} cibles au plus attendue`);
    else rawAlt.forEach((a, i) => alternates.push(checkSemantic(c, a, `${path}.alternates[${i}]`)));
  }
  return { ...head, alternates };
}

function checkBudget(c: Checker, v: unknown, path: string): StepAgentBudget {
  if (v === undefined) return STEP_REPAIR_DEFAULTS.agentBudget;
  const b = isRecord(v) ? v : {};
  if (!isRecord(v)) c.fail(path, 'objet attendu');
  c.keys(b, path, ['max_steps', 'max_usd']);
  return {
    max_steps: c.int(b['max_steps'], `${path}.max_steps`, 1, 50, STEP_REPAIR_DEFAULTS.agentBudget.max_steps),
    max_usd: c.num(b['max_usd'], `${path}.max_usd`, 0, 10, STEP_REPAIR_DEFAULTS.agentBudget.max_usd),
  };
}

function checkCompiledWith(c: Checker, v: unknown, path: string): CompiledWith {
  if (v === undefined || v === null) return { rules: [], model_id: null, at: null };
  const w = isRecord(v) ? v : {};
  c.keys(w, path, ['rules', 'model_id', 'at']);
  const rules = Array.isArray(w['rules']) && w['rules'].length <= MAX_RULES && w['rules'].every((r) => typeof r === 'string' && /^[^\s@#]{1,120}@[^\s@#]{1,40}#[a-f0-9]{64}$/.test(r)) ? (w['rules'] as string[]) : null;
  if (rules === null) c.fail(`${path}.rules`, 'liste « nom@version#sha256 » attendue');
  const model = w['model_id'] === null || w['model_id'] === undefined ? null : c.str(w['model_id'], `${path}.model_id`, 200);
  const at = w['at'] === null || w['at'] === undefined ? null : c.str(w['at'], `${path}.at`, 40);
  return { rules: rules ?? [], model_id: model, at };
}

/** Une étape (règles communes au compilé et aux étapes insérées par un patch). */
function checkStep(c: Checker, v: unknown, path: string, hosts: readonly string[]): StepDef | null {
  if (!isRecord(v)) {
    c.fail(path, 'étape attendue');
    return null;
  }
  const op = v['op'];
  if (typeof op !== 'string' || !(STEP_OPS as readonly string[]).includes(op)) {
    c.fail(`${path}.op`, 'opération hors de la liste fermée (goto, click, type, select, scroll, wait_for, extract)');
    return null;
  }
  const common = ['id', 'op', 'side_effect', 'params', 'agent_budget', 'compiled_with'];
  const id = typeof v['id'] === 'string' && ID_RE.test(v['id']) ? v['id'] : '';
  if (id === '') c.fail(`${path}.id`, 'identifiant [A-Za-z0-9_-]{1,40} attendu');
  const declared = v['side_effect'];
  if (declared !== undefined && !(STEP_SIDE_EFFECTS as readonly string[]).includes(declared as string)) c.fail(`${path}.side_effect`, '« none », « navigation » ou « write » attendu');
  let step: Omit<StepDef, 'side_effect' | 'params' | 'agent_budget' | 'compiled_with'> & { params?: string[] };
  switch (op as StepOp) {
    case 'goto':
      c.keys(v, path, [...common, 'url']);
      step = { id, op: 'goto', url: c.url(v['url'], `${path}.url`, hosts) };
      break;
    case 'click':
    case 'wait_for':
      c.keys(v, path, [...common, 'target']);
      step = { id, op: op as StepOp, target: checkTarget(c, v['target'], `${path}.target`) };
      break;
    case 'type':
    case 'select': {
      c.keys(v, path, [...common, 'target', 'value', 'form']);
      const value = isRecord(v['value']) ? v['value'] : null;
      const input = value !== null && typeof value['input'] === 'string' && INPUT_RE.test(value['input']) && Object.keys(value).length === 1 ? value['input'] : null;
      if (input === null) c.fail(`${path}.value`, '{ input: <nom d’une entrée du run> } attendu (aucun texte libre)');
      if (v['form'] !== undefined && typeof v['form'] !== 'boolean') c.fail(`${path}.form`, 'booléen attendu');
      step = {
        id,
        op: op as StepOp,
        target: checkTarget(c, v['target'], `${path}.target`),
        value: { input: input ?? '' },
        ...(typeof v['form'] === 'boolean' ? { form: v['form'] } : {}),
        params: input === null ? [] : [input],
      };
      break;
    }
    case 'scroll':
      c.keys(v, path, [...common, 'direction']);
      if (v['direction'] !== 'up' && v['direction'] !== 'down') c.fail(`${path}.direction`, '« up » ou « down » attendu');
      step = { id, op: 'scroll', direction: v['direction'] === 'up' ? 'up' : 'down' };
      break;
    case 'extract': {
      c.keys(v, path, [...common, 'fields']);
      const fields = validateLabelFields(v['fields']);
      if (!fields.ok) for (const e of fields.errors) c.fail(path, e);
      step = { id, op: 'extract', fields: fields.ok ? fields.fields : {} };
      break;
    }
  }
  // `side_effect` : le code calcule ; un effet déclaré plus fort est gardé, jamais un plus faible (19 §4).
  const computed = computeSideEffect(step);
  const side_effect = declared === 'none' || declared === 'navigation' || declared === 'write' ? maxSideEffect(computed, declared) : computed;
  return {
    ...step,
    side_effect,
    params: step.params ?? [],
    agent_budget: checkBudget(c, v['agent_budget'], `${path}.agent_budget`),
    compiled_with: checkCompiledWith(c, v['compiled_with'], `${path}.compiled_with`),
  };
}

/** Valide une stratégie `steps` ; les défauts (`agent_budget`, `compiled_with`, `limits`) et `side_effect` sont posés ici. */
export function validateStepsSpec(input: unknown): StepsCheck<StepsSpec> {
  const c = new Checker();
  if (!isRecord(input)) return { ok: false, errors: ['spec : objet attendu'] };
  c.keys(input, 'spec', ['schema_version', 'kind', 'start_url', 'allowed_hosts', 'steps', 'limits', 'compiled_from']);
  if (input['schema_version'] !== 1) c.fail('schema_version', '1 attendu');
  if (input['kind'] !== 'steps') c.fail('kind', '« steps » attendu');
  const rawHosts = input['allowed_hosts'];
  let hosts: string[] = [];
  if (!Array.isArray(rawHosts) || rawHosts.length === 0 || rawHosts.length > 10 || !rawHosts.every((h) => typeof h === 'string' && HOST_RE.test(h))) {
    c.fail('allowed_hosts', 'liste de 1 à 10 noms d’hôte attendue');
  } else hosts = rawHosts.map((h: string) => h.toLowerCase());
  const start = c.url(input['start_url'], 'start_url', hosts);
  const steps: StepDef[] = [];
  const raw = input['steps'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STEPS) c.fail('steps', `liste de 1 à ${MAX_STEPS} étapes attendue`);
  else raw.forEach((s, i) => {
    const step = checkStep(c, s, `steps[${i}]`, hosts);
    if (step !== null) steps.push(step);
  });
  const ids = steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) c.fail('steps', 'identifiants d’étape uniques attendus');
  const limits = isRecord(input['limits']) ? input['limits'] : {};
  if (input['limits'] !== undefined) c.keys(limits, 'limits', ['timeout_ms', 'step_timeout_ms', 'max_input_chars']);
  let compiledFrom: StepsSpec['compiled_from'];
  if (input['compiled_from'] !== undefined) {
    const f = isRecord(input['compiled_from']) ? input['compiled_from'] : {};
    if (f['execution'] !== 'agent') c.fail('compiled_from.execution', '« agent » attendu');
    const version = f['version'] === null ? null : c.int(f['version'], 'compiled_from.version', 1, 2 ** 31 - 1, 1);
    compiledFrom = { execution: 'agent', version, engine: c.str(f['engine'], 'compiled_from.engine', 80) };
  }
  const spec: StepsSpec = {
    schema_version: 1,
    kind: 'steps',
    start_url: start,
    allowed_hosts: hosts,
    steps,
    limits: {
      timeout_ms: c.int(limits['timeout_ms'], 'limits.timeout_ms', 1000, 1_800_000, 120_000),
      step_timeout_ms: c.int(limits['step_timeout_ms'], 'limits.step_timeout_ms', 500, 120_000, 15_000),
      max_input_chars: c.int(limits['max_input_chars'], 'limits.max_input_chars', 500, 400_000, 60_000),
    },
    ...(compiledFrom === undefined ? {} : { compiled_from: compiledFrom }),
  };
  return c.errors.length === 0 ? { ok: true, spec } : { ok: false, errors: c.errors };
}

function checkPost(c: Checker, v: unknown, path: string): StepPost | null {
  if (!isRecord(v)) {
    c.fail(path, 'condition attendue');
    return null;
  }
  switch (v['kind']) {
    case 'url_changed':
      c.keys(v, path, ['kind']);
      return { kind: 'url_changed' };
    case 'url_contains':
    case 'text_present':
      c.keys(v, path, ['kind', 'value']);
      return { kind: v['kind'], value: c.str(v['value'], `${path}.value`, MAX_TEXT) };
    case 'element_present':
    case 'element_absent':
      c.keys(v, path, ['kind', 'role', 'name']);
      return { kind: v['kind'], role: c.role(v['role'], `${path}.role`), name: c.str(v['name'], `${path}.name`, MAX_NAME) };
    default:
      c.fail(`${path}.kind`, 'condition hors de la liste fermée');
      return null;
  }
}

function checkPostList(c: Checker, v: unknown, path: string): StepPost[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_POST) {
    c.fail(path, `liste de ${MAX_POST} conditions au plus attendue`);
    return [];
  }
  return v.map((p, i) => checkPost(c, p, `${path}[${i}]`)).filter((p): p is StepPost => p !== null);
}

/** Valide `source.steps` d'une version contre son compilé : une entrée par étape connue, conditions en liste fermée. */
export function validateStepsSource(input: unknown, spec: Pick<StepsSpec, 'steps'>): { ok: true; steps: StepSource[] } | { ok: false; errors: readonly string[] } {
  const c = new Checker();
  if (!Array.isArray(input) || input.length > MAX_STEPS) return { ok: false, errors: ['source.steps : liste attendue'] };
  const known = new Set(spec.steps.map((s) => s.id));
  const out: StepSource[] = [];
  input.forEach((raw, i) => {
    const path = `source.steps[${i}]`;
    if (!isRecord(raw)) {
      c.fail(path, 'objet attendu');
      return;
    }
    c.keys(raw, path, ['id', 'intent', 'pre', 'post', 'derived_from_untrusted']);
    const id = typeof raw['id'] === 'string' ? raw['id'] : '';
    if (!known.has(id)) c.fail(`${path}.id`, 'étape inconnue du compilé');
    const pre = isRecord(raw['pre']) ? raw['pre'] : {};
    if (raw['pre'] !== undefined && !isRecord(raw['pre'])) c.fail(`${path}.pre`, 'objet attendu');
    c.keys(pre, `${path}.pre`, ['url_contains', 'element_present']);
    const element = isRecord(pre['element_present']) ? pre['element_present'] : null;
    out.push({
      id,
      intent: sanitizeStepIntent(raw['intent']),
      pre: {
        ...(pre['url_contains'] === undefined ? {} : { url_contains: c.str(pre['url_contains'], `${path}.pre.url_contains`, MAX_TEXT) }),
        ...(element === null ? {} : { element_present: { role: c.role(element['role'], `${path}.pre.element_present.role`), name: c.str(element['name'], `${path}.pre.element_present.name`, MAX_NAME) } }),
      },
      post: checkPostList(c, raw['post'], `${path}.post`),
      derived_from_untrusted: true,
    });
  });
  if (new Set(out.map((s) => s.id)).size !== out.length) c.fail('source.steps', 'une entrée par étape');
  return c.errors.length === 0 ? { ok: true, steps: out } : { ok: false, errors: c.errors };
}

/** Validation interne d'une étape isolée (insertion par un patch) avec les règles de la spec. */
export function validateStepDef(input: unknown, hosts: readonly string[]): { ok: true; step: StepDef } | { ok: false; errors: readonly string[] } {
  const c = new Checker();
  const step = checkStep(c, input, 'step', hosts);
  return step !== null && c.errors.length === 0 ? { ok: true, step } : { ok: false, errors: c.errors };
}

/** Cible principale d'une étape, sans ses alternates (rôle + nom, ou texte). */
export function primaryTarget(target: StepTarget): StepAlternate {
  return 'text' in target ? { text: target.text } : { role: target.role, name: target.name };
}

/** Nom lisible d'une cible (journal, panneau). */
export function targetLabel(target: StepAlternate): string {
  return 'text' in target ? `text:${target.text}` : `${target.role}:${target.name}`;
}

/** Conditions `post` seules (étapes instruites de l'agent instruit). */
export function validatePostList(input: unknown, path = 'post'): { ok: true; post: StepPost[] } | { ok: false; errors: readonly string[] } {
  const c = new Checker();
  const post = checkPostList(c, input, path);
  return c.errors.length === 0 ? { ok: true, post } : { ok: false, errors: c.errors };
}
