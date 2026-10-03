// SPDX-License-Identifier: AGPL-3.0-only
// Compilation E6 → E5 au grain de l'étape (tâche 2.13, 19 §4) : une E5 compilée et vérifiée devient une stratégie `steps`
// avec sa source (intention écrite par le code, `post` dérivée de la trace), `compiled_with` vide avant 2.10.
import { describe, expect, test } from 'vitest';
import type { AgentTraceStep } from '../agent/engine.js';
import { validateHybridSpec } from '../agent/specs.js';
import { compileHybridToSteps } from './compile.js';

const HOST = 'zz-test.example';
const hybrid = (steps: unknown[], extract: unknown = { mode: 'labels', fields: { titre: { label: 'Titre', ops: [] } } }) => {
  const c = validateHybridSpec({ schema_version: 1, kind: 'hybrid', start_url: `https://${HOST}/`, allowed_hosts: [HOST], steps, extract, compiled_from: { execution: 'agent', version: 1, engine: 'stagehand@3.7.3' } });
  if (!c.ok) throw new Error(c.errors.join(';'));
  return c.spec;
};
const trace: AgentTraceStep[] = [
  { index: 0, action: 'click', semanticTarget: { role: 'link', name: 'Fiche du vélo' }, url: `https://${HOST}/`, executed: true, durationMs: 1 },
  { index: 1, action: 'read', url: `https://${HOST}/velo`, executed: true, durationMs: 1 },
  { index: 2, action: 'done', url: `https://${HOST}/velo`, executed: true, durationMs: 1 },
];

describe('compilation E6 → E5 au grain de l’étape', () => {
  test('une étape par action, extraction finale, intention écrite par le code, post url_changed tirée de la trace', () => {
    const out = compileHybridToSteps(hybrid([{ op: 'click', target: { role: 'link', name: 'Fiche du vélo' } }]), { modelId: 'zz-agent', at: '2026-10-02T10:00:00Z', trace });
    expect(out).not.toBeNull();
    expect(out!.spec.kind).toBe('steps');
    expect(out!.spec.steps.map((s) => [s.id, s.op, s.side_effect])).toEqual([
      ['s1', 'click', 'navigation'],
      ['s2', 'extract', 'none'],
    ]);
    expect(out!.spec.steps[0]!.compiled_with).toEqual({ rules: [], model_id: 'zz-agent', at: '2026-10-02T10:00:00Z' });
    expect(out!.source[0]).toMatchObject({ id: 's1', intent: 'Cliquer sur l’élément link « Fiche du vélo »', post: [{ kind: 'url_changed' }], derived_from_untrusted: true });
    expect(out!.spec.compiled_from).toEqual({ execution: 'agent', version: 1, engine: 'stagehand@3.7.3' });
  });
  test('étape ou extraction déléguée à l’agent : non compilable', () => {
    expect(compileHybridToSteps(hybrid([{ op: 'agent', instruction: 'x' }]), { modelId: null, at: 'x' })).toBeNull();
    expect(compileHybridToSteps(hybrid([], { mode: 'agent', instruction: 'x' }), { modelId: null, at: 'x' })).toBeNull();
  });
});
