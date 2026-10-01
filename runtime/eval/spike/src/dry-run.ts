// Répétition à blanc (protocole §6, tâche 0.6a étape 3) : scénarios du faux fournisseur pour que les 90 runs s'exécutent
// de bout en bout sans LLM réel, en passant par toutes les branches du harnais (réussite, faux succès, sortie hors schéma
// refusée par le moteur, injection obéie). Les issues produites ici ne disent RIEN des moteurs.
import { scripted, type FakeRequestContext, type ScriptedStep } from '@runtime/llm/testing';
import type { AgentFixtureTask } from '../../../fixtures/src/agent-tasks.ts';
import type { PlannedRun } from './plan.ts';

const usage = { prompt_tokens: 1200, completion_tokens: 150, cached_tokens: 400, reasoning_tokens: 60 };

function lastUserText(ctx: FakeRequestContext): string {
  const messages = (ctx.body['messages'] ?? []) as { role: string; content: unknown }[];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && typeof m.content === 'string' && m.content.includes('snapshot_id:')) return m.content;
  }
  return '';
}

function partial(reference: unknown): unknown {
  const items = (reference as { items?: unknown[] }).items;
  if (Array.isArray(items)) return { items: items.slice(0, -1) };
  return { ...(reference as Record<string, unknown>), color: 'zz_test_faux' };
}

export function dryRunScript(planned: PlannedRun, task: AgentFixtureTask, port: number, reference: unknown): ScriptedStep[] {
  const falseSuccess = planned.seq % 9 === 4;
  const out = falseSuccess ? partial(reference) : reference;
  const obeysInjection = task.injection !== undefined && (planned.run === 3 || planned.run === 5);
  const trapUrl = task.injection ? `http://${task.injection.trapHost}:${port}/collect` : '';

  if (planned.engine === 'home_loop') {
    const steps: ScriptedStep[] = [];
    if (obeysInjection) steps.push(scripted.toolCalls([{ name: 'navigate', arguments: { url: trapUrl } }], usage));
    if (task.key === 'F-E5') {
      // Deux clics réels sur « Suivant » : le canal, le snapshot_id et les refs sont exercés.
      const click = (ctx: FakeRequestContext) => {
        const text = lastUserText(ctx);
        const snapshotId = /snapshot_id: (\S+)/.exec(text)?.[1] ?? '';
        const ref = /button "Suivant"[^\n]*\[ref=(\w+)\]/.exec(text)?.[1] ?? 'e0';
        return scripted.toolCalls([{ name: 'click', arguments: { snapshot_id: snapshotId, ref } }], usage);
      };
      steps.push(click, click);
    }
    if (planned.seq % 13 === 6) steps.push(scripted.toolCalls([{ name: 'done', arguments: { output: { wrong: true } } }], usage));
    steps.push(scripted.toolCalls([{ name: 'done', arguments: { output: out } }], usage));
    return steps;
  }

  // Stagehand : un tour sans outil clôt la boucle, puis Stagehand force l'appel « done » (handleDoneToolCall).
  const steps: ScriptedStep[] = [];
  if (obeysInjection) steps.push(scripted.toolCalls([{ name: 'goto', arguments: { url: trapUrl } }], usage));
  steps.push(scripted.text('The task is complete.', usage));
  steps.push(scripted.toolCalls([{ name: 'done', arguments: { reasoning: 'zz_test dry run', taskComplete: true, output: out } }], usage));
  return steps;
}
