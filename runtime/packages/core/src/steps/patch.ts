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
  const routes: Route[] = [];
  for (const [i, op] of (patch as unknown[]).entries()) {
    if (!isRecord(op) || Object.keys(op).some((k) => !['op', 'path', 'value'].includes(k))) {
      rejections.push({ code: 'invalid_patch', index: i, message: `opération ${i} : { op, path, value } attendu` });
      continue;
    }
    const r = route(op);
    if (r === null) {
      rejections.push({ code: 'forbidden_path', index: i, message: `opération ${i} : chemin hors de /steps/i/target et de l’insertion d’une étape` });
      continue;
    }
    routes.push(r);
  }
  if (rejections.length > 0) return { ok: false, rejections };

  // Étapes `write` du compilé : jamais reciblées (19 §4 « Étapes à effet »).
  for (const [i, r] of routes.entries()) {
    if (r.kind === 'target' && spec.steps[r.step]?.side_effect === 'write') {
      rejections.push({ code: 'write_step_not_repairable', index: i, message: `étape ${r.step} : side_effect write, jamais réparée seule` });
    }
  }
  // Étapes insérées : validées seules, puis bornées.
  for (const [i, r] of routes.entries()) {
    if (r.kind !== 'insert') continue;
    const value = (patch as Record<string, unknown>[])[i]!['value'];
    const checked = validateStepDef(value, spec.allowed_hosts);
    if (!checked.ok) {
      rejections.push({ code: 'patched_spec_invalid', index: i, message: checked.errors.join(' ; ') });
      continue;
    }
    const step = checked.step;
    if (step.op === 'type' && !options.runInputs.includes(step.value?.input ?? '')) {
      rejections.push({ code: 'type_not_run_input', index: i, message: `étape insérée : « ${step.value?.input ?? ''} » n’est pas une entrée du run` });
    }
    if (step.op === 'select' && step.form !== false) rejections.push({ code: 'select_in_form', index: i, message: 'étape insérée : select dans un formulaire' });
    // `side_effect` recalculé SANS l'avis du patch : un effet déclaré est ignoré.
    const computed = computeSideEffect(step);
    if (computed === 'write' && !rejections.some((x) => x.index === i)) {
      rejections.push({ code: 'inserted_step_write', index: i, message: 'étape insérée : side_effect write (envoi, saisie dans un formulaire, clic qui soumet)' });
    }
  }
  if (rejections.length > 0) return { ok: false, rejections };

  let patched: unknown;
  try {
    patched = jsonpatch.apply(patch as jsonpatch.OpObject[], structuredClone(spec) as never);
  } catch {
    return { ok: false, rejections: [{ code: 'patched_spec_invalid', index: null, message: 'patch inapplicable' }] };
  }
  // `side_effect` des étapes reciblées et insérées : recalculé à partir de la seule forme (jamais repris du patch).
  const raw = patched as { steps?: Record<string, unknown>[] };
  const changed = new Set<number>();
  let offset = 0;
  for (const r of routes) {
    if (r.kind === 'insert') {
      changed.add(r.step);
      offset += 1;
    } else changed.add(r.step + offset);
  }
  for (const i of changed) {
    const s = raw.steps?.[i];
    if (isRecord(s)) {
      const target = isRecord(s['target']) ? (s['target'] as { role?: string; name?: string; text?: string }) : undefined;
      s['side_effect'] = computeSideEffect({ op: String(s['op']), target, ...(typeof s['form'] === 'boolean' ? { form: s['form'] } : {}) });
    }
  }
  const checked = validateStepsSpec(patched);
  if (!checked.ok) return { ok: false, rejections: [{ code: 'patched_spec_invalid', index: null, message: checked.errors.join(' ; ') }] };
  for (const i of changed) {
    const s = checked.spec.steps[i];
    if (s !== undefined && s.side_effect === 'write') {
      return { ok: false, rejections: [{ code: 'retargeted_step_write', index: null, message: `étape ${i} : la cible proposée donnerait un side_effect write` }] };
    }
  }
  // Rien d'autre n'a bougé : mêmes domaines, même page de départ, mêmes opérations hors des étapes touchées.
  if (JSON.stringify(checked.spec.allowed_hosts) !== JSON.stringify(spec.allowed_hosts) || checked.spec.start_url !== spec.start_url) {
    return { ok: false, rejections: [{ code: 'forbidden_path', index: null, message: 'domaines ou page de départ modifiés' }] };
  }
  return { ok: true, spec: checked.spec, operations: patch as JsonPatchOperation[], touched: [...changed].sort((a, b) => a - b) };
}
