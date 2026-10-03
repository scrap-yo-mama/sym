// SPDX-License-Identifier: AGPL-3.0-only
// Compilation E6 → E5 au grain de l'étape (19 §4, r2 R14, tâche 2.13) : la stratégie E5 compilée et VÉRIFIÉE par rejeu
// sans LLM (agent/compile.ts, 2.4) est écrite au format `steps`, une étape par action de la trace, avec sa source :
// - `intent` décrite PAR LE CODE à partir de l'action (« Cliquer sur le lien « X » ») : la trace figée par l'ADR 0001 ne
//   porte pas la raison de l'appel d'outil, et un texte écrit par le code n'apporte aucune consigne d'une page ;
// - `post` dérivée de la trace : `url_changed` quand l'URL a changé après l'action ; l'extraction exige ses champs ;
// - `compiled_with` : règles (`nom@version#sha256`, reprises du `compiled_with` de l’étape hybride posé par 2.10 ; l’extraction
//   porte leur union) et modèle.
// Une stratégie qui délègue une étape ou l'extraction à l'agent n'est pas compilable (`null`).
import type { AgentTraceStep } from '../agent/engine.js';
import type { HybridSpec } from '../agent/specs.js';
import { validateStepsSource, validateStepsSpec, type StepSource, type StepsSpec } from './spec.js';

const quote = (s: string): string => `« ${s.replace(/\s+/g, ' ').trim().slice(0, 120)} »`;
const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
};

export function compileHybridToSteps(
  hybrid: HybridSpec,
  options: { readonly modelId: string | null; readonly at: string; readonly trace?: readonly AgentTraceStep[] },
): { spec: StepsSpec; source: StepSource[] } | null {
  if (hybrid.extract.mode !== 'labels') return null;
  // URL avant / après chaque action exécutée de la trace (navigations et clics, comme la compilation de 2.4).
  const acted = (options.trace ?? []).filter((t) => t.executed && (t.action === 'navigate' || t.action === 'click'));
  const urlAfter = (k: number): string | undefined => {
    const t = acted[k];
    if (t === undefined) return undefined;
    const all = options.trace ?? [];
    const next = all.find((s) => s.index > t.index);
    return next?.url;
  };
  // Règles de compilation de chaque étape (`compiled_with` posé par 2.10 sur l’étape hybride), modèle et date de la trace.
  const allRules = new Set<string>();
  const withRules = (rules: readonly string[] | undefined): { rules: string[]; model_id: string | null; at: string } => {
    for (const r of rules ?? []) allRules.add(r);
    return { rules: [...(rules ?? [])], model_id: options.modelId, at: options.at };
  };
  const steps: Record<string, unknown>[] = [];
  const source: Record<string, unknown>[] = [];
  let k = 0;
  for (const step of hybrid.steps) {
    const id = `s${steps.length + 1}`;
    switch (step.op) {
      case 'agent':
        return null;
      case 'wait':
        continue;
      case 'scroll':
        steps.push({ id, op: 'scroll', direction: step.direction, compiled_with: withRules(step.compiled_with?.rules) });
        source.push({ id, intent: step.direction === 'down' ? 'Faire défiler la page vers le bas' : 'Faire défiler la page vers le haut', pre: {}, post: [] });
        continue;
      case 'goto':
        steps.push({ id, op: 'goto', url: step.url, compiled_with: withRules(step.compiled_with?.rules) });
        source.push({ id, intent: `Aller sur ${pathOf(step.url)}`, pre: {}, post: [] });
        k += 1;
        continue;
      case 'click': {
        const before = acted[k]?.url;
        const after = urlAfter(k);
        k += 1;
        steps.push({ id, op: 'click', target: { role: step.target.role, name: step.target.name, alternates: [] }, compiled_with: withRules(step.compiled_with?.rules) });
        const changed = before !== undefined && after !== undefined && after !== before;
        source.push({ id, intent: `Cliquer sur l’élément ${step.target.role} ${quote(step.target.name)}`, pre: { element_present: { role: step.target.role, name: step.target.name } }, post: changed ? [{ kind: 'url_changed' }] : [] });
        continue;
      }
    }
  }
  const id = `s${steps.length + 1}`;
  steps.push({ id, op: 'extract', fields: hybrid.extract.fields, compiled_with: withRules([...allRules]) });
  source.push({ id, intent: `Lire les champs ${Object.keys(hybrid.extract.fields).slice(0, 10).join(', ')}`, pre: {}, post: [] });
  const checked = validateStepsSpec({
    schema_version: 1,
    kind: 'steps',
    start_url: hybrid.start_url,
    allowed_hosts: hybrid.allowed_hosts,
    steps,
    limits: { timeout_ms: hybrid.limits.timeout_ms, step_timeout_ms: hybrid.limits.step_timeout_ms, max_input_chars: hybrid.limits.max_input_chars },
    ...(hybrid.compiled_from === undefined ? {} : { compiled_from: hybrid.compiled_from }),
  });
  if (!checked.ok) return null;
  const src = validateStepsSource(source, checked.spec);
  return src.ok ? { spec: checked.spec, source: src.steps } : null;
}
