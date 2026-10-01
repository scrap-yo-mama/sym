// SPDX-License-Identifier: AGPL-3.0-only
// Pilote CDP du contrat `agent_step` dans l'extension (07 § 3, tâches 0.6b et 2.7) : lecture de la page par
// `Accessibility.getFullAXTree` (arbre rendu au format des instantanés, `[ref=e<backendNodeId>]`), actions par
// `Input.*` et `DOM.*` de la liste blanche. Avant d'agir, la cible est revérifiée (rôle et nom) : une page qui a changé
// donne `stale_ref`, jamais une action sur un autre élément. Aucune évaluation de code (`Runtime.*` absent).
// Garde d'écriture (07 § 5) tenue ici aussi, pas seulement par le classement rôle + nom : avant un clic, l'élément visé
// ET l'élément réellement touché au point du clic sont remontés jusqu'à la racine ; un bouton d'envoi parmi eux, quel
// que soit son libellé, est une écriture (`write_action_not_allowed`, `write_action_blocked` sur le fil).
import { detectChallenge, isWriteElement, isWriteTarget, type AgentStepAction, type AgentStepDriver, type StepExpectedTarget, type StepObservation } from '@runtime/core/tunnel';

type AxValue = { value?: unknown };
export type AxNode = { nodeId: string; ignored?: boolean; role?: AxValue; name?: AxValue; childIds?: string[]; parentId?: string; backendDOMNodeId?: number };

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

/** Envoi CDP (liste blanche appliquée par l'appelant). */
export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

type DomNode = { nodeName?: string; attributes?: string[]; backendNodeId?: number; children?: DomNode[] };

/** Plus d'ancêtres que cela : page anormale, traitée comme une écriture (fermé). */
const MAX_ANCESTORS = 256;

const describe = async (send: CdpSend, params: Record<string, unknown>): Promise<DomNode | null> => {
  const out = (await send('DOM.describeNode', params).catch(() => null)) as { node?: DomNode } | null;
  return out?.node ?? null;
};

const attr = (node: DomNode, name: string): string | undefined => {
  const attrs = node.attributes ?? [];
  for (let i = 0; i + 1 < attrs.length; i += 2) if (attrs[i]?.toLowerCase() === name) return attrs[i + 1];
  return undefined;
};

/**
 * L'activation de cet élément DOM envoie-t-elle un formulaire ? Bouton d'envoi (`isWriteElement`, `inForm` : un
 * ancêtre `<form>` dans la chaîne lue) ; `<label for>` : son contrôle ne se résout qu'avec `DOM.getDocument`, qui
 * invaliderait les `nodeId` du script, donc écriture (fermé) ; `<label>` qui enveloppe un bouton d'envoi : écriture
 * (un `<form>` entre le label et le bouton compte aussi).
 */
async function elementIsWrite(send: CdpSend, node: DomNode, inForm: boolean): Promise<boolean> {
  if (isWriteElement(node, { inForm })) return true;
  if ((node.nodeName ?? '').toUpperCase() !== 'LABEL') return false;
  if ((attr(node, 'for') ?? '') !== '') return true;
  if (typeof node.backendNodeId !== 'number') return true;
  const deep = await describe(send, { backendNodeId: node.backendNodeId, depth: -1 });
  return deep === null || someWriteDescendant(deep, inForm);
}

const isForm = (node: DomNode): boolean => (node.nodeName ?? '').toUpperCase() === 'FORM';

/**
 * Au-dessus d'un nœud de la chaîne d'accessibilité, le contexte de formulaire est-il possible ? Un `<form>`, ou un
 * élément `aria-owns` : il réordonne l'arbre d'accessibilité (vérifié dans Chromium, le `<form>` DOM disparaît alors
 * de la chaîne), les vrais ancêtres DOM sont inconnus (fermé).
 */
const formContext = (node: DomNode): boolean => isForm(node) || attr(node, 'aria-owns') !== undefined;

/** Un descendant de `node` est-il un bouton d'envoi ? `inForm` passe à vrai sous un `<form>`. Budget dépassé = oui. */
function someWriteDescendant(node: DomNode, inForm: boolean, budget = { left: 10_000 }): boolean {
  return (node.children ?? []).some((c) => {
    if ((budget.left -= 1) <= 0) return true;
    const below = inForm || isForm(c);
    return isWriteElement(c, { inForm: below }) || someWriteDescendant(c, below, budget);
  });
}

/** Chaîne nœud → racine dans un arbre d'accessibilité partiel ; `null` si elle n'atteint pas `RootWebArea` (fermé). */
function ancestorChain(nodes: readonly AxNode[], backendNodeId: number): AxNode[] | null {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const parentOf = new Map<string, string>();
  for (const n of nodes) for (const c of n.childIds ?? []) if (!parentOf.has(c)) parentOf.set(c, n.nodeId);
  let cur = nodes.find((n) => n.backendDOMNodeId === backendNodeId);
  const chain: AxNode[] = [];
  const seen = new Set<string>();
  while (cur !== undefined) {
    if (seen.has(cur.nodeId) || chain.length > MAX_ANCESTORS) return null;
    seen.add(cur.nodeId);
    chain.push(cur);
    const parentId = typeof cur.parentId === 'string' ? cur.parentId : parentOf.get(cur.nodeId);
    if (parentId === undefined) break;
    cur = byId.get(parentId);
    if (cur === undefined) return null; // parent annoncé mais absent : chaîne incomplète
  }
  const top = chain[chain.length - 1];
  return top !== undefined && str(top.role) === 'RootWebArea' ? chain : null;
}

/**
 * Activer ce nœud (clic, focus puis touche) est-il une écriture (07 § 5) ? Le nœud ET tous ses ancêtres jusqu'à la
 * racine : un `<span>` ou une icône dans un bouton d'envoi l'active. Pour chacun, bouton d'envoi (DOM, quel que soit le
 * libellé) ou élément accessible au libellé d'écriture. Un `<button>` sans type n'est un bouton d'envoi que si un
 * `<form>` (ou un élément `aria-owns`, contexte inconnu) figure au-dessus de lui dans la chaîne lue (Chromium y garde
 * les nœuds ignorés, `<form>` sans nom compris) ou s'il porte un attribut `form`. Fermé : nœud, arbre ou ancêtre illisible = écriture.
 */
export async function activationIsWrite(send: CdpSend, ref: { backendNodeId: number } | { nodeId: number }): Promise<boolean> {
  const node = await describe(send, { ...ref, depth: 0 });
  if (node === null) return true;
  const backendNodeId = typeof node.backendNodeId === 'number' ? node.backendNodeId : 'backendNodeId' in ref ? ref.backendNodeId : null;
  if (backendNodeId === null) return true;
  const tree = (await send('Accessibility.getPartialAXTree', { backendNodeId, fetchRelatives: true }).catch(() => null)) as { nodes?: unknown } | null;
  if (!Array.isArray(tree?.nodes)) return true;
  const chain = ancestorChain(tree.nodes as AxNode[], backendNodeId);
  if (chain === null) return true;
  // Chaîne DOM nœud → racine, lue en entier avant de juger : le contexte de formulaire d'un nœud est au-dessus de lui.
  const doms: DomNode[] = [{ ...node, backendNodeId }];
  const seen = new Set<number>([backendNodeId]);
  for (const ax of chain) {
    if (isWriteTarget({ role: str(ax.role), name: str(ax.name) })) return true;
    const id = ax.backendDOMNodeId;
    if (typeof id !== 'number' || seen.has(id)) continue;
    seen.add(id);
    const ancestor = await describe(send, { backendNodeId: id, depth: 0 });
    if (ancestor === null) return true;
    doms.push({ ...ancestor, backendNodeId: id });
  }
  for (const [i, dom] of doms.entries()) {
    if (await elementIsWrite(send, dom, doms.slice(i + 1).some(formContext))) return true;
  }
  return false;
}

/**
 * Un clic aux coordonnées (x, y) de la FENÊTRE (`Input.dispatchMouseEvent`) active-t-il une écriture ? Le nœud
 * réellement touché : `DOM.getNodeForLocation` attend des coordonnées du DOCUMENT (vérifié dans Chromium : page
 * défilée, la même valeur ne touche rien), d'où le défilement lu par `Page.getLayoutMetrics` ; `pointer-events: none`
 * respecté comme par le clic réel (jamais `ignorePointerEventsNone`, qui inspecterait une couche que le clic traverse).
 * Fermé : défilement illisible ou aucun nœud = écriture.
 */
export async function clickIsWrite(send: CdpSend, x: number, y: number): Promise<boolean> {
  const metrics = (await send('Page.getLayoutMetrics', {}).catch(() => null)) as { cssVisualViewport?: { pageX?: unknown; pageY?: unknown } } | null;
  const pageX = metrics?.cssVisualViewport?.pageX;
  const pageY = metrics?.cssVisualViewport?.pageY;
  if (typeof pageX !== 'number' || typeof pageY !== 'number' || !Number.isFinite(pageX) || !Number.isFinite(pageY)) return true;
  const hit = (await send('DOM.getNodeForLocation', { x: Math.round(x + pageX), y: Math.round(y + pageY) }).catch(() => null)) as { backendNodeId?: unknown } | null;
  if (typeof hit?.backendNodeId !== 'number') return true;
  return activationIsWrite(send, { backendNodeId: hit.backendNodeId });
}

export type CdpPort = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** URL courante de l'onglet. */
  url(): Promise<string>;
  /** Attend la fin d'un chargement éventuel (navigation, clic qui navigue). */
  settle(): Promise<void>;
  /** `allow_write_actions` de la commande en cours (lu à chaque action). */
  allowWriteActions(): boolean;
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

  async perform(action: AgentStepAction, expected?: StepExpectedTarget): Promise<{ ok: true } | { ok: false; error: 'stale_ref' | 'timeout' | 'domain_not_allowed' | 'write_action_not_allowed' }> {
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
          const send: CdpSend = (method, params) => this.#port.send(method, params);
          const guarded = !this.#port.allowWriteActions();
          // L'élément visé, remonté jusqu'à la racine : un bouton d'envoi au libellé neutre (« OK », « Suivant »).
          if (guarded && (await activationIsWrite(send, { backendNodeId }))) return { ok: false, error: 'write_action_not_allowed' };
          await this.#port.send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
          const box = (await this.#port.send('DOM.getBoxModel', { backendNodeId })) as { model?: { content?: number[] } } | null;
          const q = box?.model?.content;
          if (q === undefined || q.length < 8) return { ok: false, error: 'stale_ref' };
          const x = (q[0]! + q[2]! + q[4]! + q[6]!) / 4;
          const y = (q[1]! + q[3]! + q[5]! + q[7]!) / 4;
          // Ce que le clic touchera vraiment à ce point (un bouton d'envoi peut recouvrir l'élément visé).
          if (guarded && (await clickIsWrite(send, x, y))) return { ok: false, error: 'write_action_not_allowed' };
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

  /** Premier filtre, sur le rôle et le nom de l'instantané ; `perform` inspecte ensuite le DOM avant tout clic. */
  classify(action: AgentStepAction, target: StepExpectedTarget): 'read' | 'write' {
    if (action.kind === 'type') return 'read';
    return isWriteTarget(target) ? 'write' : 'read';
  }

  challengeDetected(observation: StepObservation): boolean {
    const title = /^- RootWebArea "((?:[^"\\]|\\.)*)"/.exec(observation.tree)?.[1];
    return detectChallenge({ url: observation.url, text: observation.tree, ...(title === undefined ? {} : { title }) });
  }
}
