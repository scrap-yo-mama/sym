// SPDX-License-Identifier: AGPL-3.0-only
// Outil `read_skill` de nos prompts (tâche 2.10, 18 §4.4, §4.5) : quand l'ensemble résolu liste au moins un skill, une
// phase courte précède la sortie structurée du rôle (`investigate`, `repair`) : le modèle peut appeler `read_skill(name)`,
// exécuté par NOTRE processus (`SkillReader` : skills de l'ensemble résolu seulement, sinon `skill_not_found`). Les corps
// lus rejoignent ensuite le préfixe de confiance (<trusted_skills>) de l'appel structuré. Bornes : 3 appels au plus, sortie
// courte ; chaque appel passe par la même garde de budget (`beforeCall`) et le même compteur que l'appel principal.
// Sans skill applicable : aucun appel de plus (comportement de 2.1 et 2.3 inchangé).
import { READ_SKILL_TOOL, type SkillReader } from '@runtime/core';
import type { ChatMessage, LlmClient, ToolDef } from '@runtime/llm';

export const SKILL_PHASE_MAX_CALLS = 3;
const SKILL_PHASE_MAX_TOKENS = 512;

const TOOL: ToolDef = { type: 'function', function: { name: READ_SKILL_TOOL.name, description: READ_SKILL_TOOL.description, parameters: READ_SKILL_TOOL.parameters } };

export type SkillBody = { readonly ref: string; readonly sha256: string; readonly content: string };

/** Le corps d'un skill ne peut ni fermer ni ouvrir une section du prompt. */
const neutral = (text: string): string => text.replace(/<\s*(\/?)\s*(trusted_rules|trusted_skills|skills|untrusted_[a-z_]*|user_feedback)/gi, '‹$1$2');

/** Section de confiance des skills lus, à placer après <trusted_rules> et <skills>. */
export function renderSkillBodies(bodies: readonly SkillBody[]): string {
  if (bodies.length === 0) return '';
  return ['<trusted_skills>', ...bodies.map((b) => `## ${b.ref}\n${neutral(b.content)}`), '</trusted_skills>'].join('\n');
}

const SKILL_PHASE_NOTE = 'Before answering, you may call read_skill(name) for a skill listed in <skills> that matters for this task. When you have what you need, answer with a short text "ready" and no tool call.';

/** Phase `read_skill` : rend les corps lus (dans l'ordre de lecture). */
export async function readSkillsPhase(
  client: LlmClient,
  role: 'investigate' | 'repair',
  args: { readonly messages: readonly ChatMessage[]; readonly reader: SkillReader; readonly signal?: AbortSignal; readonly beforeCall?: () => void },
): Promise<SkillBody[]> {
  if (args.reader.names.length === 0) return [];
  const messages: ChatMessage[] = [...args.messages, { role: 'user', content: SKILL_PHASE_NOTE }];
  const bodies: SkillBody[] = [];
  for (let i = 0; i < SKILL_PHASE_MAX_CALLS; i += 1) {
    const out = await client.chat(role, {
      messages,
      tools: [TOOL],
      toolChoice: 'auto',
      maxTokens: SKILL_PHASE_MAX_TOKENS,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
      ...(args.beforeCall === undefined ? {} : { beforeCall: args.beforeCall }),
    });
    const message = out.result.message;
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) break;
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });
    for (const [index, call] of calls.entries()) {
      let name: unknown;
      try {
        name = (JSON.parse(call.function.arguments) as { name?: unknown }).name;
      } catch {
        name = null;
      }
      // Au plus 4 lectures par tour ; chaque appel reçoit une réponse (historique valide pour le fournisseur).
      const read = call.function.name === READ_SKILL_TOOL.name && index < 4 ? args.reader.read(name) : ({ ok: false, code: 'skill_not_found' } as const);
      if (read.ok && !bodies.some((b) => b.ref === read.ref)) bodies.push({ ref: read.ref, sha256: read.sha256, content: read.content });
      messages.push({ role: 'tool', tool_call_id: call.id, content: read.ok ? read.content : read.code });
    }
  }
  return bodies;
}
