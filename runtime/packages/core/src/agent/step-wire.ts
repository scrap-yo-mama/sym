// SPDX-License-Identifier: AGPL-3.0-only
// Contrat `agent_step` du tunnel sur le fil (07 §3 et §8, tâche 0.6b). Module pur, sans Node ni navigateur : le
// serveur (client `agent_step` du paquet agent) et l'extension (exécuteur, tâche 2.6/2.7) importent les mêmes types et
// les mêmes validations. Jeu fermé : toute commande hors des cinq actions, tout champ en plus, toute chaîne qui ressemble
// à du code est refusée par `method_not_allowed`, sans rien évaluer (`assert_no_remote_logic`).
import type { AgentSnapshot, AgentStepAction, AgentStepErrorCode, AgentStepResult } from './engine.js';

export const AGENT_STEP_ACTIONS = Object.freeze(['navigate', 'click', 'type', 'scroll', 'read'] as const);

/**
 * Codes d'erreur portés par le fil. 07 §8 en nomme quatre (`method_not_allowed`, `stale_ref`, `write_action_blocked`,
 * `challenge_in_tunnel`) ; `domain_not_allowed` (07 §5, refus d'un domaine non connecté) et `timeout` complètent le
 * jeu pour que chaque refus du canal serveur ait son équivalent dans le tunnel.
 */
export type AgentStepWireError = 'stale_ref' | 'method_not_allowed' | 'write_action_blocked' | 'challenge_in_tunnel' | 'domain_not_allowed' | 'timeout';

/** Correspondance entre les codes du canal (`AgentStepErrorCode`) et ceux du fil. */
const CORE_TO_WIRE = {
  stale_ref: 'stale_ref',
  domain_not_allowed: 'domain_not_allowed',
  method_not_allowed: 'method_not_allowed',
  write_action_not_allowed: 'write_action_blocked',
  challenge_detected: 'challenge_in_tunnel',
  timeout: 'timeout',
} as const satisfies Record<AgentStepErrorCode, AgentStepWireError>;

const WIRE_TO_CORE: Readonly<Record<AgentStepWireError, AgentStepErrorCode>> = Object.freeze(
  Object.fromEntries(Object.entries(CORE_TO_WIRE).map(([core, wire]) => [wire, core])) as Record<AgentStepWireError, AgentStepErrorCode>,
);

/** `args` de la commande `agent_step` (07 §8 : `{ action, ref, snapshot_id }`, plus `url`, `text`, `direction`). */
export interface AgentStepWireArgs {
  readonly action: (typeof AGENT_STEP_ACTIONS)[number];
  readonly url?: string;
  readonly ref?: string;
  readonly snapshot_id?: string;
  readonly text?: string;
  readonly direction?: 'up' | 'down';
}

export interface AgentStepWireSnapshot {
  readonly snapshot_id: string;
  readonly url: string;
  /** Arbre d'accessibilité tronqué ; contenu non fiable (08 §4). */
  readonly tree: string;
  readonly truncated: boolean;
}

/**
 * Corps (réassemblé par la passerelle) de la réponse à un `agent_step`. Les autres champs de l'enveloppe de 07 §8
 * (`job_id`, `seq`, `last`, `ms`…) appartiennent à la passerelle (tâche 2.7).
 */
export interface AgentStepWireResult {
  readonly ok: boolean;
  /** Identifiant de l'instantané porté par la réponse, `null` si elle n'en porte pas. */
  readonly snapshot_id: string | null;
  readonly error: AgentStepWireError | null;
  readonly snapshot: AgentStepWireSnapshot | null;
}

/** Plafonds de validation : une réponse tient largement dans un message de 1 Mio (07 §6). */
export const MAX_WIRE_TREE_CHARS = 64_000;
const MAX_URL_CHARS = 2048;
const MAX_TEXT_CHARS = 4096;
const REF = /^[a-z0-9]{1,32}$/;
const SNAPSHOT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function agentStepErrorToWire(error: AgentStepErrorCode): AgentStepWireError {
  return CORE_TO_WIRE[error];
}

export function agentStepErrorFromWire(error: AgentStepWireError): AgentStepErrorCode {
  return WIRE_TO_CORE[error];
}

/** Action du moteur vers les `args` du fil. */
export function agentStepToWire(action: AgentStepAction): AgentStepWireArgs {
  switch (action.kind) {
    case 'navigate':
      return { action: 'navigate', url: action.url };
    case 'click':
      return { action: 'click', ref: action.target.ref, snapshot_id: action.target.snapshotId };
    case 'type':
      return { action: 'type', ref: action.target.ref, snapshot_id: action.target.snapshotId, text: action.text };
    case 'scroll':
      return { action: 'scroll', snapshot_id: action.snapshotId, direction: action.direction };
    case 'read':
      return action.snapshotId === undefined ? { action: 'read' } : { action: 'read', snapshot_id: action.snapshotId };
  }
}

export type ParsedAgentStepArgs = { readonly ok: true; readonly action: AgentStepAction } | { readonly ok: false; readonly error: 'method_not_allowed'; readonly reason: string };

const refuse = (reason: string): ParsedAgentStepArgs => ({ ok: false, error: 'method_not_allowed', reason });

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_CHARS) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/** Champs permis par action (le premier groupe est obligatoire, le second optionnel). */
const SHAPES: Readonly<Record<AgentStepWireArgs['action'], { required: readonly string[]; optional: readonly string[] }>> = {
  navigate: { required: ['url'], optional: [] },
  click: { required: ['ref', 'snapshot_id'], optional: [] },
  type: { required: ['ref', 'snapshot_id', 'text'], optional: [] },
  scroll: { required: ['snapshot_id', 'direction'], optional: [] },
  read: { required: [], optional: ['snapshot_id'] },
};

/**
 * Valide les `args` reçus (côté extension) et les rend sous la forme d'une action. Aucun champ hors du jeu fermé,
 * aucun `ref` ou identifiant qui ne soit de forme attendue : une chaîne de code n'a nulle part où passer.
 */
export function parseAgentStepArgs(raw: unknown): ParsedAgentStepArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return refuse('args : objet attendu');
  const record = raw as Record<string, unknown>;
  const name = record['action'];
  if (typeof name !== 'string' || !(AGENT_STEP_ACTIONS as readonly string[]).includes(name)) return refuse('action hors du jeu fermé');
  const shape = SHAPES[name as AgentStepWireArgs['action']];
  const allowed = new Set(['action', ...shape.required, ...shape.optional]);
  for (const key of Object.keys(record)) if (!allowed.has(key)) return refuse(`champ non prévu : ${key}`);
  for (const key of shape.required) if (record[key] === undefined) return refuse(`champ manquant : ${key}`);
  const snapshotId = record['snapshot_id'];
  if (snapshotId !== undefined && !(typeof snapshotId === 'string' && SNAPSHOT_ID.test(snapshotId))) return refuse('snapshot_id invalide');
  const ref = record['ref'];
  if (ref !== undefined && !(typeof ref === 'string' && REF.test(ref))) return refuse('ref invalide');
  switch (name) {
    case 'navigate':
      return isHttpUrl(record['url']) ? { ok: true, action: { kind: 'navigate', url: record['url'] } } : refuse('url http(s) attendue');
    case 'click':
      return { ok: true, action: { kind: 'click', target: { snapshotId: snapshotId as string, ref: ref as string } } };
    case 'type': {
      const text = record['text'];
      if (typeof text !== 'string' || text.length > MAX_TEXT_CHARS) return refuse('text invalide');
      return { ok: true, action: { kind: 'type', target: { snapshotId: snapshotId as string, ref: ref as string }, text } };
    }
    case 'scroll': {
      const direction = record['direction'];
      if (direction !== 'up' && direction !== 'down') return refuse('direction invalide');
      return { ok: true, action: { kind: 'scroll', snapshotId: snapshotId as string, direction } };
    }
    default:
      return { ok: true, action: snapshotId === undefined ? { kind: 'read' } : { kind: 'read', snapshotId: snapshotId as string } };
  }
}

const snapshotToWire = (snapshot: AgentSnapshot): AgentStepWireSnapshot => ({
  snapshot_id: snapshot.snapshotId,
  url: snapshot.url,
  tree: snapshot.accessibilityTree,
  truncated: snapshot.truncated,
});

/** Résultat du canal vers le corps de réponse du fil. */
export function agentStepResultToWire(result: AgentStepResult): AgentStepWireResult {
  const snapshot = result.snapshot === undefined ? null : snapshotToWire(result.snapshot);
  return {
    ok: result.ok,
    snapshot_id: snapshot?.snapshot_id ?? null,
    error: result.ok ? null : agentStepErrorToWire(result.error),
    snapshot,
  };
}

function parseSnapshot(raw: unknown): AgentSnapshot | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const id = r['snapshot_id'];
  const tree = r['tree'];
  if (typeof id !== 'string' || !SNAPSHOT_ID.test(id)) return undefined;
  if (typeof r['url'] !== 'string' || r['url'].length > MAX_URL_CHARS) return undefined;
  if (typeof tree !== 'string' || tree.length > MAX_WIRE_TREE_CHARS) return undefined;
  if (typeof r['truncated'] !== 'boolean') return undefined;
  return { snapshotId: id, url: r['url'], accessibilityTree: tree, truncated: r['truncated'] };
}

/**
 * Valide une réponse du fil (côté serveur) et la rend sous la forme d'un résultat du canal ; `null` si elle viole le
 * contrat (le client la traite comme une erreur de protocole, jamais comme un succès). Contrat : un succès porte un
 * instantané, un `stale_ref` porte le nouvel instantané, `snapshot_id` du haut = celui de l'instantané.
 */
export function parseAgentStepWireResult(raw: unknown): AgentStepResult | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['ok'] !== 'boolean') return null;
  const snapshot = parseSnapshot(r['snapshot']);
  if (snapshot === undefined) return null;
  const topId = r['snapshot_id'];
  if (snapshot === null ? topId !== null : topId !== snapshot.snapshotId) return null;
  const error = r['error'];
  if (r['ok']) {
    return error === null && snapshot !== null ? { ok: true, snapshot } : null;
  }
  if (typeof error !== 'string' || !Object.hasOwn(WIRE_TO_CORE, error)) return null;
  const code = WIRE_TO_CORE[error as AgentStepWireError];
  if (code === 'stale_ref' && snapshot === null) return null;
  return snapshot === null ? { ok: false, error: code } : { ok: false, error: code, snapshot };
}
