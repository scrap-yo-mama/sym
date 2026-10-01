// SPDX-License-Identifier: AGPL-3.0-only
// Modèle scripté pour Stagehand 3.7.3 sur le faux fournisseur (tâche 2.4) : `turns` sont les tours de la boucle d'agent ;
// l'inférence interne de l'outil `act` (« finding elements ») désigne le lien dont le nom figure entre guillemets dans
// l'action ; l'appel `done` forcé rend `output`. Le modèle ne lit pas la page : il rend la sortie attendue, et c'est le
// rejeu E5 sans LLM qui prouve qu'elle est bien sur la page.
import { scripted, type FakeRequestContext, type ScriptedResponse, type ScriptedStep } from '@runtime/llm/testing';

export const textOf = (content: unknown): string => (typeof content === 'string' ? content : JSON.stringify(content));

export function stagehandScript(turns: ScriptedResponse[], output: unknown): ScriptedStep[] {
  let turn = 0;
  const step = (ctx: FakeRequestContext): ScriptedResponse => {
    const messages = (ctx.body['messages'] ?? []) as { content: unknown }[];
    if (textOf(messages[0]?.content).includes('finding elements')) {
      const user = textOf(messages.at(-1)?.content);
      const name = /click the link \\?"([^"\\]+)\\?"/.exec(user)?.[1] ?? '';
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const id = new RegExp(`\\[(\\d+-\\d+)\\] link: ${escaped}`).exec(user)?.[1];
      return scripted.json({ action: id === undefined ? null : { elementId: id, description: 'link', method: 'click', arguments: [] }, twoStep: false });
    }
    const tools = ((ctx.body['tools'] ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
    if (tools.length === 1 && tools[0] === 'done') return scripted.toolCalls([{ name: 'done', arguments: { reasoning: 'zz_test', taskComplete: true, output } }]);
    return turns[turn++] ?? scripted.text('The task is complete.');
  };
  return Array.from({ length: 40 }, () => step);
}
