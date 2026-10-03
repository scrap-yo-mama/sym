// SPDX-License-Identifier: AGPL-3.0-only
// Patch BORNÉ d'une reprise par étape (19 §4, r2 R6 à R9, tâche 2.13) : RFC 6902 sur `/steps/i/target` (reciblage, avec
// ses `alternates`) ou insertion d'une étape (`add /steps/i`), rien d'autre. Interdit en particulier sur `post` et `pre`
// (source immuable), `allowed_hosts`, `session`, `output_schema`, `side_effect`, l'opération, les budgets, `start_url`.
// Une étape insérée ou reciblée est limitée à un `side_effect` `none` ou `navigation` CALCULÉ PAR LE CODE : aucun `type`
// hors des entrées du run, aucun `select` dans un formulaire, aucun clic qui soumet (mutation `insert_submit`). Une étape
// `write` n'est jamais reciblée. Le patch s'applique à une copie ; le résultat est revalidé en entier.
import { jsonpatch } from 'json-p3';
import type { JsonPatchOperation } from '../model/types.js';
import { computeSideEffect } from './side-effect.js';
import { validateStepDef, validateStepsSpec, type StepsSpec } from './spec.js';

export type StepPatchRejectionCode =
  | 'invalid_patch'
  | 'too_many_operations'
  | 'forbidden_path'
  | 'inserted_step_write'
  | 'retargeted_step_write'
  | 'write_step_not_repairable'
  | 'type_not_run_input'
  | 'select_in_form'
  | 'patched_spec_invalid';

export type StepPatchRejection = { readonly code: StepPatchRejectionCode; readonly index: number | null; readonly message: string };
export type StepPatchCheck =
  | { readonly ok: true; readonly spec: StepsSpec; readonly operations: JsonPatchOperation[]; readonly touched: number[] }
  | { readonly ok: false; readonly rejections: StepPatchRejection[] };

const MAX_OPERATIONS = 10;
const STEP_INDEX = /^(0|[1-9]\d{0,2})$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** `/steps/<i>/target`, `/steps/<i>/target/alternates`, `/steps/<i>/target/alternates/<j|->` ou `/steps/<i>` (add). */
type Route = { kind: 'target'; step: number } | { kind: 'insert'; step: number };

function route(op: Record<string, unknown>): Route | null {
  const path = op['path'];
  if (typeof path !== 'string') return null;
  const seg = path.split('/');
  if (seg[0] !== '' || seg[1] !== 'steps' || seg[2] === undefined || !STEP_INDEX.test(seg[2])) return null;
  const step = Number(seg[2]);
  if (seg.length === 3) return op['op'] === 'add' ? { kind: 'insert', step } : null;
  if (seg[3] !== 'target') return null;
  if (seg.length === 4) return op['op'] === 'replace' ? { kind: 'target', step } : null;
  if (seg[4] !== 'alternates') return null;
  if (seg.length === 5) return op['op'] === 'replace' ? { kind: 'target', step } : null;
  if (seg.length === 6 && (seg[5] === '-' || STEP_INDEX.test(seg[5] ?? ''))) return ['add', 'replace', 'remove'].includes(String(op['op'])) ? { kind: 'target', step } : null;
  return null;
}

export function validateStepPatch(spec: StepsSpec, patch: unknown, options: { runInputs: readonly string[] }): StepPatchCheck {
  const rejections: StepPatchRejection[] = [];
  if (!Array.isArray(patch) || patch.length === 0) return { ok: false, rejections: [{ code: 'invalid_patch', index: null, message: 'patch : tableau non vide attendu' }] };
  if (patch.length > MAX_OPERATIONS) return { ok: false, rejections: [{ code: 'too_many_operations', index: null, message: `patch : ${MAX_OPERATIONS} opérations au plus` }] };
  for (const [i, op] of (patch as unknown[]).entries()) {
    if (!isRecord(op) || Object.keys(op).some((k) => !['op', 'path', 'value'].includes(k))) {
      rejections.push({ code: 'invalid_patch', index: i, message: `opération ${i} : { op, path, value } attendu` });
      continue;
    }
    if (route(op) === null) {
      rejections.push({ code: 'forbidden_path', index: i, message: `opération ${i} : chemin hors de /steps/i/target et de l’insertion d’une étape` });
      continue;
    }
  }
  if (rejections.length > 0) return { ok: false, rejections };

  // Application dans l'ordre RFC 6902 (sur une copie), puis contrôle par IDENTIFIANT d'étape : les indices bougent au fil
  // des insertions, l'identifiant non. Une étape nouvelle est une insertion ; une étape connue ne peut changer que de cible.
  let patched: unknown;
  try {
    patched = jsonpatch.apply(patch as jsonpatch.OpObject[], structuredClone(spec) as never);
  } catch {
    return { ok: false, rejections: [{ code: 'patched_spec_invalid', index: null, message: 'patch inapplicable' }] };
  }
  const raw = patched as { steps?: unknown };
  if (!Array.isArray(raw.steps)) return { ok: false, rejections: [{ code: 'patched_spec_invalid', index: null, message: 'steps : liste attendue' }] };
  const before = new Map(spec.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const touched: number[] = [];
  const steps = raw.steps as unknown[];
  const sameExceptTarget = (a: Record<string, unknown>, b: Record<string, unknown>): boolean => {
    const strip = ({ target: _t, side_effect: _s, ...rest }: Record<string, unknown>) => rest;
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  };
  for (const [i, s] of steps.entries()) {
    if (!isRecord(s) || typeof s['id'] !== 'string') return { ok: false, rejections: [{ code: 'patched_spec_invalid', index: i, message: `étape ${i} : identifiant attendu` }] };
    const id = s['id'];
    if (seen.has(id)) return { ok: false, rejections: [{ code: 'patched_spec_invalid', index: i, message: `étape ${i} : identifiant en double` }] };
    seen.add(id);
    const old = before.get(id);
    if (old === undefined) {
      // Insertion : validée seule, `side_effect` et `form` déclarés ignorés (calculés par le code ; `form` inconnu).
      const { side_effect: _declared, form: _form, ...shape } = s;
      const checked = validateStepDef(shape, spec.allowed_hosts);
      if (!checked.ok) return { ok: false, rejections: [{ code: 'patched_spec_invalid', index: i, message: checked.errors.join(' ; ') }] };
      const step = checked.step;
      if (step.op === 'type' && !options.runInputs.includes(step.value?.input ?? '')) {
        return { ok: false, rejections: [{ code: 'type_not_run_input', index: i, message: `étape insérée : « ${step.value?.input ?? ''} » n’est pas une entrée du run` }] };
      }
      if (step.op === 'select') return { ok: false, rejections: [{ code: 'select_in_form', index: i, message: 'étape insérée : select (formulaire possible)' }] };
      if (computeSideEffect(step) === 'write') {
        return { ok: false, rejections: [{ code: 'inserted_step_write', index: i, message: 'étape insérée : side_effect write (envoi, saisie dans un formulaire, clic qui soumet)' }] };
      }
      steps[i] = { ...shape, side_effect: computeSideEffect(step) };
      touched.push(i);
      continue;
    }
    const oldRaw = old as unknown as Record<string, unknown>;
    if (!sameExceptTarget(s, oldRaw)) return { ok: false, rejections: [{ code: 'forbidden_path', index: i, message: `étape ${id} : seule sa cible peut changer` }] };
    if (JSON.stringify(s['target']) === JSON.stringify(oldRaw['target'])) {
      // Étape inchangée : son `side_effect` est gardé tel quel (jamais abaissé par un recalcul).
      steps[i] = { ...s, side_effect: old.side_effect };
      continue;
    }
    // Reciblage : jamais une étape `write` ; la nouvelle cible ne doit pas donner un effet `write` (forme d'origine).
    if (old.side_effect === 'write') return { ok: false, rejections: [{ code: 'write_step_not_repairable', index: i, message: `étape ${id} : side_effect write, jamais réparée seule` }] };
    const target = isRecord(s['target']) ? (s['target'] as { role?: string; name?: string; text?: string }) : undefined;
    const computed = computeSideEffect({ op: old.op, target, ...(old.form === undefined ? {} : { form: old.form }) });
    if (computed === 'write') return { ok: false, rejections: [{ code: 'retargeted_step_write', index: i, message: `étape ${id} : la cible proposée donnerait un side_effect write` }] };
    steps[i] = { ...s, side_effect: computed };
    touched.push(i);
  }
  // Aucune étape retirée.
  if (spec.steps.some((s) => !seen.has(s.id))) return { ok: false, rejections: [{ code: 'forbidden_path', index: null, message: 'étape retirée' }] };
  const checked = validateStepsSpec(patched);
  if (!checked.ok) return { ok: false, rejections: [{ code: 'patched_spec_invalid', index: null, message: checked.errors.join(' ; ') }] };
  // Rien d'autre n'a bougé : mêmes domaines, même page de départ, mêmes plafonds.
  if (JSON.stringify(checked.spec.allowed_hosts) !== JSON.stringify(spec.allowed_hosts) || checked.spec.start_url !== spec.start_url || JSON.stringify(checked.spec.limits) !== JSON.stringify(spec.limits)) {
    return { ok: false, rejections: [{ code: 'forbidden_path', index: null, message: 'domaines, page de départ ou plafonds modifiés' }] };
  }
  return { ok: true, spec: checked.spec, operations: patch as JsonPatchOperation[], touched };
}
