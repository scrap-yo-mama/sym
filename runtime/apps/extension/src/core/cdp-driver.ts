// SPDX-License-Identifier: AGPL-3.0-only
// Pilote CDP du contrat `agent_step` dans l'extension (07 § 3, tâches 0.6b et 2.7) : lecture de la page par
// `Accessibility.getFullAXTree` (arbre rendu au format des instantanés, `[ref=e<backendNodeId>]`), actions par
// `Input.*` et `DOM.*` de la liste blanche. Avant d'agir, la cible est revérifiée (rôle et nom) : une page qui a changé
// donne `stale_ref`, jamais une action sur un autre élément. Aucune évaluation de code (`Runtime.*` absent).
import { detectChallenge, isWriteTarget, type AgentStepAction, type AgentStepDriver, type StepExpectedTarget, type StepObservation } from '@runtime/core/tunnel';

type AxValue = { value?: unknown };
export type AxNode = { nodeId: string; ignored?: boolean; role?: AxValue; name?: AxValue; childIds?: string[]; backendDOMNodeId?: number };

/** Rôles de mise en forme sans intérêt pour le modèle : leurs enfants remontent d'un niveau. */
const TRANSPARENT = new Set(['generic', 'none', 'GenericContainer', 'InlineTextBox', 'LineBreak', 'presentation', 'Ignored', 'IgnoredRole']);
const TEXT_ROLES = new Set(['StaticText', 'text']);

const str = (v: AxValue | undefined): string => (typeof v?.value === 'string' ? v.value : '');
const quote = (s: string): string => `"${s.replace(/[\r\n\t]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 300)}"`;

/** Arbre d'accessibilité CDP → texte de l'instantané (une ligne par élément, indentation par profondeur). */
export function renderAxTree(nodes: readonly AxNode[]): string {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes[0];
  if (root === undefined) return '';
  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (node: AxNode, depth: number): void => {
    if (seen.has(node.nodeId) || lines.length > 20_000) return;
    seen.add(node.nodeId);
    const role = str(node.role);
    const name = str(node.name).trim();
    let childDepth = depth;
    if (node.ignored !== true && !(TRANSPARENT.has(role) && name === '')) {
      const indent = '  '.repeat(depth);
      if (TEXT_ROLES.has(role)) {
        if (name !== '') lines.push(`${indent}- text ${quote(name)}`);
      } else {
        const safeRole = /^[a-zA-Z]+$/.test(role) ? role : 'generic';
        const ref = node.backendDOMNodeId === undefined ? '' : ` [ref=e${node.backendDOMNodeId}]`;
        lines.push(`${indent}- ${safeRole}${name === '' ? '' : ` ${quote(name)}`}${ref}`);
        childDepth = depth + 1;
      }
    }
    for (const id of node.childIds ?? []) {
      const child = byId.get(id);
      if (child !== undefined) walk(child, childDepth);
    }
  };
  walk(root, 0);
  return lines.join('\n');
}

export type CdpPort = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** URL courante de l'onglet. */
  url(): Promise<string>;
  /** Attend la fin d'un chargement éventuel (navigation, clic qui navigue). */
  settle(): Promise<void>;
};

const backendOf = (ref: string): number | null => {
  const m = /^e(\d{1,12})$/.exec(ref);
  return m === null ? null : Number(m[1]);
};

export class CdpStepDriver implements AgentStepDriver {
  readonly #port: CdpPort;

  constructor(port: CdpPort) {
    this.#port = port;
  }

  async observe(): Promise<StepObservation> {
    const out = (await this.#port.send('Accessibility.getFullAXTree', {})) as { nodes?: AxNode[] } | null;
    return { url: await this.#port.url(), tree: renderAxTree(out?.nodes ?? []) };
  }

  /** L'élément `backendNodeId` est-il toujours celui que l'instantané décrivait ? */
  async #matches(backendNodeId: number, expected: StepExpectedTarget | undefined): Promise<boolean> {
    if (expected === undefined) return false;
    try {
      const out = (await this.#port.send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: false })) as { nodes?: AxNode[] } | null;
      const node = out?.nodes?.find((n) => n.backendDOMNodeId === backendNodeId) ?? out?.nodes?.[0];
      if (node === undefined) return false;
      const role = str(node.role);
      return (/^[a-zA-Z]+$/.test(role) ? role : 'generic') === expected.role && str(node.name).trim() === expected.name;
    } catch {
      return false;
    }
  }

  async perform(action: AgentStepAction, expected?: StepExpectedTarget): Promise<{ ok: true } | { ok: false; error: 'stale_ref' | 'timeout' | 'domain_not_allowed' }> {
    switch (action.kind) {
      case 'navigate':
        await this.#port.send('Page.navigate', { url: action.url });
        await this.#port.settle();
        return { ok: true };
      case 'scroll':
        await this.#port.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 200, y: 200, deltaX: 0, deltaY: action.direction === 'down' ? 600 : -600 });
        return { ok: true };
      case 'read':
        return { ok: true };
      case 'click':
      case 'type': {
        const backendNodeId = backendOf(action.target.ref);
        if (backendNodeId === null || !(await this.#matches(backendNodeId, expected))) return { ok: false, error: 'stale_ref' };
        try {
          if (action.kind === 'type') {
            await this.#port.send('DOM.focus', { backendNodeId });
            await this.#port.send('Input.insertText', { text: action.text });
            return { ok: true };
          }
          await this.#port.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
          const box = (await this.#port.send('DOM.getBoxModel', { backendNodeId })) as { model?: { content?: number[] } } | null;
          const q = box?.model?.content;
          if (q === undefined || q.length < 8) return { ok: false, error: 'stale_ref' };
          const x = (q[0]! + q[2]! + q[4]! + q[6]!) / 4;
          const y = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
          await this.#port.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
          await this.#port.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
          await this.#port.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
          await this.#port.settle();
          return { ok: true };
        } catch {
          return { ok: false, error: 'stale_ref' };
        }
      }
    }
  }

  classify(action: AgentStepAction, target: StepExpectedTarget): 'read' | 'write' {
    if (action.kind === 'type') return 'read';
    return isWriteTarget(target) ? 'write' : 'read';
  }

  challengeDetected(observation: StepObservation): boolean {
    const title = /^- RootWebArea "((?:[^"\\]|\\.)*)"/.exec(observation.tree)?.[1];
    return detectChallenge({ url: observation.url, text: observation.tree, ...(title === undefined ? {} : { title }) });
  }
}
