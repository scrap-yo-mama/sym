// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur `agent_step` et suivi des instantanés (07 §3, tâche 0.6b), sans Node ni navigateur : l'extension (tâche 2.7)
// l'appelle avec un pilote CDP ; les tests l'appellent avec une page factice. Il porte la règle du contrat : un `ref`
// n'est valable que pour l'instantané qui l'a émis ET tant que la page n'a pas changé ; sinon `stale_ref`, rien n'est
// exécuté et le nouvel instantané est rendu. Un défi arrête tout : plus aucune commande n'atteint le pilote (07 §5).
import type { AgentSnapshot, AgentStepAction, AgentStepResult } from './engine.js';
import { agentStepResultToWire, parseAgentStepArgs, type AgentStepWireResult } from './step-wire.js';

export const DEFAULT_MAX_TREE_CHARS = 16_000;

/** Tronque l'arbre à une limite de caractères, sur une fin de ligne. */
export function truncateTree(tree: string, maxChars: number): { text: string; truncated: boolean } {
  if (tree.length <= maxChars) return { text: tree, truncated: false };
  const cut = tree.lastIndexOf('\n', maxChars);
  return { text: `${tree.slice(0, cut > 0 ? cut : maxChars)}\n- [truncated]`, truncated: true };
}

/** Vrai si le `ref` figure dans l'arbre (sinon : référence inconnue, traitée comme périmée). */
export function hasRef(tree: string, ref: string): boolean {
  return /^[a-z0-9]+$/.test(ref) && tree.includes(`[ref=${ref}]`);
}

const REF_ITEM = /^([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?[^\n]*?\[ref=([a-z0-9]+)\]/;

/**
 * Clé d'un élément de liste YAML (`- clé` ou `- clé:`). Playwright cite entre guillemets simples toute clé qui le
 * demande (un nom qui contient « : », p. ex.), `''` valant `'` (`yamlEscapeKeyIfNeeded`, playwright-core 1.63).
 */
function itemKey(line: string): string | undefined {
  const item = /^\s*-\s+(.*)$/.exec(line);
  const body = item?.[1];
  if (body === undefined) return undefined;
  if (!body.startsWith("'")) return body;
  let key = '';
  for (let i = 1; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "'") key += ch;
    else if (body[i + 1] === "'") {
      key += "'";
      i += 1;
    } else return key;
  }
  return undefined;
}

/**
 * Sélecteur sémantique (rôle + nom accessible) d'un `ref` dans un arbre : c'est lui que la trace consigne, jamais le
 * seul `ref` (04 §3.1, compilation E6 → E5). `undefined` si la ligne est illisible : l'exécuteur refuse alors d'agir.
 */
export function semanticOf(tree: string, ref: string): { role: string; name: string } | undefined {
  for (const line of tree.split('\n')) {
    if (!line.includes(`[ref=${ref}]`)) continue;
    const key = itemKey(line);
    const match = key === undefined ? null : REF_ITEM.exec(key);
    if (match?.[3] !== ref) continue;
    return { role: match[1] ?? 'generic', name: (match[2] ?? '').replace(/\\(.)/g, '$1') };
  }
  return undefined;
}

/** Empreinte synchrone (cyrb53) de l'URL et de l'arbre : pas de `node:crypto`, l'extension tourne dans un service worker. */
function digestOf(url: string, tree: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const text = `${url}\n${tree}`;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Ce que le navigateur montre à l'instant : URL et arbre d'accessibilité complet (non tronqué). */
export interface StepObservation {
  readonly url: string;
  readonly tree: string;
}

interface Current {
  readonly snapshot: AgentSnapshot;
  readonly fullTree: string;
  readonly digest: string;
}

export type StepVerdict = { readonly ok: true } | { readonly ok: false; readonly snapshot: AgentSnapshot };

export class StepSnapshotTracker {
  readonly #maxTreeChars: number;
  #counter = 0;
  #current: Current | undefined;

  constructor(options: { readonly maxTreeChars?: number } = {}) {
    this.#maxTreeChars = options.maxTreeChars ?? DEFAULT_MAX_TREE_CHARS;
  }

  /** Enregistre l'observation : une page inchangée garde son `snapshot_id`, une page modifiée en reçoit un nouveau. */
  observe(observation: StepObservation): AgentSnapshot {
    const digest = digestOf(observation.url, observation.tree);
    if (this.#current?.digest === digest) return this.#current.snapshot;
    const { text, truncated } = truncateTree(observation.tree, this.#maxTreeChars);
    this.#counter += 1;
    const snapshot: AgentSnapshot = { snapshotId: `s${this.#counter}-${digest.slice(0, 6)}`, url: observation.url, accessibilityTree: text, truncated };
    this.#current = { snapshot, fullTree: observation.tree, digest };
    return snapshot;
  }

  /**
   * L'action vise-t-elle l'instantané courant, et la page est-elle restée la même depuis ? Sinon, le nouvel instantané
   * (déjà enregistré) est rendu : c'est le contenu de la réponse `stale_ref`.
   */
  verify(target: { readonly snapshotId: string; readonly ref?: string }, observation: StepObservation): StepVerdict {
    const previous = this.#current;
    const snapshot = this.observe(observation);
    const now = this.#current as Current;
    if (previous === undefined || previous.snapshot.snapshotId !== target.snapshotId || now.digest !== previous.digest) return { ok: false, snapshot };
    if (target.ref !== undefined && !hasRef(now.fullTree, target.ref)) return { ok: false, snapshot };
    return { ok: true };
  }

  /** Rôle et nom accessibles d'un `ref` de l'instantané courant (trace sémantique, verrou d'écriture). */
  semanticTarget(snapshotId: string, ref: string): { role: string; name: string } | undefined {
    if (this.#current?.snapshot.snapshotId !== snapshotId) return undefined;
    return semanticOf(this.#current.fullTree, ref);
  }
}

/** Élément visé, tel que l'instantané l'a décrit : le pilote vérifie qu'il est toujours à cet endroit avant d'agir. */
export interface StepExpectedTarget {
  readonly role: string;
  readonly name: string;
}

/**
 * Pilote du navigateur (CDP dans l'extension). `perform` reçoit une action déjà validée ; pour `click` et `type` il
 * DOIT retrouver l'élément désigné par `ref` et refuser (`stale_ref`) s'il ne correspond plus à `expected`, au lieu
 * d'agir sur un autre élément : la page peut changer entre la vérification de fraîcheur et l'action.
 */
export interface AgentStepDriver {
  observe(): Promise<StepObservation>;
  perform(action: AgentStepAction, expected?: StepExpectedTarget): Promise<{ ok: true } | { ok: false; error: 'stale_ref' | 'timeout' | 'domain_not_allowed' }>;
  /**
   * Un clic d'envoi, d'achat ou de suppression est une écriture (07 §5). Obligatoire : en tunnel, aucune interception
   * réseau ne rattrape une écriture (Network en lecture seule). Un pilote qui ne la fournit pas (appelant JavaScript)
   * voit tout `click` et tout `type` traités comme des écritures tant que `allow_write_actions` est faux.
   */
  classify(action: AgentStepAction, target: StepExpectedTarget): 'read' | 'write';
  /** Vrai si la page affiche un défi ou une vérification anti-bot (07 §5, X3). */
  challengeDetected?(observation: StepObservation): boolean;
}

export interface AgentStepExecutorOptions {
  readonly driver: AgentStepDriver;
  /** Garde de domaines et d'adresses (07 §5, INV10), appliquée avant toute navigation. */
  readonly urlAllowed: (url: string) => boolean;
  /** `allow_write_actions` confirmé dans l'interface (08 §4). */
  readonly allowWriteActions: boolean;
  readonly maxTreeChars?: number;
}

export class AgentStepExecutor {
  readonly #driver: AgentStepDriver;
  readonly #options: AgentStepExecutorOptions;
  readonly #tracker: StepSnapshotTracker;
  #challenged = false;

  constructor(options: AgentStepExecutorOptions) {
    this.#driver = options.driver;
    this.#options = options;
    this.#tracker = new StepSnapshotTracker(options.maxTreeChars === undefined ? {} : { maxTreeChars: options.maxTreeChars });
  }

  /** Point d'entrée du fil : `args` bruts de la commande, corps de réponse du fil. */
  async execute(rawArgs: unknown): Promise<AgentStepWireResult> {
    const parsed = parseAgentStepArgs(rawArgs);
    if (!parsed.ok) return agentStepResultToWire({ ok: false, error: parsed.error });
    return agentStepResultToWire(await this.executeAction(parsed.action));
  }

  async #observe(): Promise<{ observation: StepObservation; snapshot: AgentSnapshot }> {
    const observation = await this.#driver.observe();
    return { observation, snapshot: this.#tracker.observe(observation) };
  }

  /** Observe après une action : un défi verrouille l'exécuteur et ne renvoie aucun contenu de page. */
  async #finish(error?: 'timeout' | 'stale_ref' | 'domain_not_allowed'): Promise<AgentStepResult> {
    const { observation, snapshot } = await this.#observe();
    if (this.#driver.challengeDetected?.(observation) === true) {
      this.#challenged = true;
      return { ok: false, error: 'challenge_detected' };
    }
    return error === undefined ? { ok: true, snapshot } : { ok: false, error, snapshot };
  }

  /** Garde d'écriture fermé par défaut : sans classifieur, toute action sur un élément est une écriture. */
  #isWrite(action: AgentStepAction, target: StepExpectedTarget): boolean {
    const classify = (this.#driver as Partial<AgentStepDriver>).classify;
    return typeof classify !== 'function' || classify.call(this.#driver, action, target) !== 'read';
  }

  async executeAction(action: AgentStepAction): Promise<AgentStepResult> {
    if (this.#challenged) return { ok: false, error: 'challenge_detected' };
    switch (action.kind) {
      case 'navigate': {
        if (!this.#options.urlAllowed(action.url)) return this.#finish('domain_not_allowed');
        const done = await this.#driver.perform(action);
        return this.#finish(done.ok ? undefined : done.error);
      }
      case 'click':
      case 'type': {
        const observation = await this.#driver.observe();
        const verdict = this.#tracker.verify({ snapshotId: action.target.snapshotId, ref: action.target.ref }, observation);
        if (!verdict.ok) return { ok: false, error: 'stale_ref', snapshot: verdict.snapshot };
        const expected = this.#tracker.semanticTarget(action.target.snapshotId, action.target.ref);
        // Cible illisible (ni rôle ni nom) : impossible de la revérifier au moment d'agir ni de la classer, donc refus.
        if (expected === undefined) return { ok: false, error: 'stale_ref', snapshot: this.#tracker.observe(observation) };
        if (!this.#options.allowWriteActions && this.#isWrite(action, expected)) {
          return { ok: false, error: 'write_action_not_allowed', snapshot: this.#tracker.observe(observation) };
        }
        const done = await this.#driver.perform(action, expected);
        return this.#finish(done.ok ? undefined : done.error);
      }
      case 'scroll': {
        const observation = await this.#driver.observe();
        const verdict = this.#tracker.verify({ snapshotId: action.snapshotId }, observation);
        if (!verdict.ok) return { ok: false, error: 'stale_ref', snapshot: verdict.snapshot };
        const done = await this.#driver.perform(action);
        return this.#finish(done.ok ? undefined : done.error);
      }
      case 'read':
        return this.#finish();
    }
  }
}
