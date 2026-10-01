// SPDX-License-Identifier: AGPL-3.0-only
// Contrat `agent_step` du tunnel (07 §3 et §8, tâche 0.6b) : forme des commandes et des réponses sur le fil, jeu fermé.
import { describe, expect, it } from 'vitest';
import {
  agentStepResultToWire,
  agentStepToWire,
  parseAgentStepArgs,
  parseAgentStepWireResult,
  type AgentStepAction,
  type AgentStepResult,
} from '../index.js';

const snapshot = { snapshotId: 's1-abc123', url: 'https://monsite.com/', accessibilityTree: '- button "OK" [ref=e1]', truncated: false };

describe('agent_step : commandes (args)', () => {
  const actions: AgentStepAction[] = [
    { kind: 'navigate', url: 'https://monsite.com/liste' },
    { kind: 'click', target: { snapshotId: 's1-abc123', ref: 'e12' } },
    { kind: 'type', target: { snapshotId: 's1-abc123', ref: 'e3' }, text: 'bonjour' },
    { kind: 'scroll', snapshotId: 's1-abc123', direction: 'down' },
    { kind: 'read' },
    { kind: 'read', snapshotId: 's1-abc123' },
  ];

  it.each(actions)('aller-retour fidèle : %j', (action) => {
    const wire = JSON.parse(JSON.stringify(agentStepToWire(action))) as unknown;
    expect(parseAgentStepArgs(wire)).toEqual({ ok: true, action });
  });

  it('le fil porte { action, ref, snapshot_id } comme au contrat 07 §8', () => {
    expect(agentStepToWire({ kind: 'click', target: { snapshotId: 's9-ffffff', ref: 'e4' } })).toEqual({ action: 'click', ref: 'e4', snapshot_id: 's9-ffffff' });
  });

  it.each([
    ['action inconnue', { action: 'evaluate', ref: 'e1', snapshot_id: 's1-abc123' }],
    ['code JS dans un champ en trop', { action: 'click', ref: 'e1', snapshot_id: 's1-abc123', expression: 'fetch("https://evil.example")' }],
    ['code dans le ref', { action: 'click', ref: 'e1;alert(1)', snapshot_id: 's1-abc123' }],
    ['ref sans snapshot_id', { action: 'click', ref: 'e1' }],
    ['snapshot_id absent d\'un type', { action: 'type', ref: 'e1', text: 'x' }],
    ['URL non http(s)', { action: 'navigate', url: 'javascript:alert(1)' }],
    ['URL file', { action: 'navigate', url: 'file:///etc/passwd' }],
    ['direction invalide', { action: 'scroll', snapshot_id: 's1-abc123', direction: 'left' }],
    ['texte trop long', { action: 'type', ref: 'e1', snapshot_id: 's1-abc123', text: 'x'.repeat(5000) }],
    ['pas un objet', 'click'],
    ['null', null],
    ['tableau', []],
  ])('refus method_not_allowed : %s', (_name, raw) => {
    expect(parseAgentStepArgs(raw)).toMatchObject({ ok: false, error: 'method_not_allowed' });
  });
});

describe('agent_step : réponses', () => {
  it('succès : snapshot_id au premier niveau et dans l\'instantané, aucune erreur', () => {
    const result: AgentStepResult = { ok: true, snapshot };
    const wire = agentStepResultToWire(result);
    expect(wire).toMatchObject({ ok: true, error: null, snapshot_id: 's1-abc123' });
    expect(parseAgentStepWireResult(JSON.parse(JSON.stringify(wire)))).toEqual(result);
  });

  it.each([
    ['stale_ref', 'stale_ref'],
    ['domain_not_allowed', 'domain_not_allowed'],
    ['method_not_allowed', 'method_not_allowed'],
    ['write_action_not_allowed', 'write_action_blocked'],
    ['challenge_detected', 'challenge_in_tunnel'],
    ['timeout', 'timeout'],
  ] as const)('code %s porté par le fil sous le nom %s, et relu à l\'identique', (core, wireName) => {
    const result: AgentStepResult = { ok: false, error: core, snapshot };
    const wire = agentStepResultToWire(result);
    expect(wire.error).toBe(wireName);
    expect(parseAgentStepWireResult(JSON.parse(JSON.stringify(wire)))).toEqual(result);
  });

  it('un refus sans instantané reste possible (défi, commande hors liste)', () => {
    const wire = agentStepResultToWire({ ok: false, error: 'challenge_detected' });
    expect(wire).toMatchObject({ ok: false, error: 'challenge_in_tunnel', snapshot_id: null, snapshot: null });
    expect(parseAgentStepWireResult(wire)).toEqual({ ok: false, error: 'challenge_detected' });
  });

  it.each([
    ['stale_ref sans nouvel instantané', { ok: false, error: 'stale_ref', snapshot_id: null, snapshot: null }],
    ['succès sans instantané', { ok: true, error: null, snapshot_id: null, snapshot: null }],
    ['succès avec une erreur', { ok: true, error: 'timeout', snapshot_id: 's1-abc123', snapshot: { snapshot_id: 's1-abc123', url: 'https://a.example/', tree: '', truncated: false } }],
    ['code d\'erreur inconnu', { ok: false, error: 'boom', snapshot_id: null, snapshot: null }],
    ['snapshot_id du haut différent de celui de l\'instantané', { ok: true, error: null, snapshot_id: 's2-aaaaaa', snapshot: { snapshot_id: 's1-abc123', url: 'https://a.example/', tree: '', truncated: false } }],
    ['arbre démesuré', { ok: true, error: null, snapshot_id: 's1-abc123', snapshot: { snapshot_id: 's1-abc123', url: 'https://a.example/', tree: 'x'.repeat(70_000), truncated: false } }],
    ['pas un objet', 42],
  ])('réponse invalide rejetée (null) : %s', (_name, raw) => {
    expect(parseAgentStepWireResult(raw)).toBeNull();
  });
});
