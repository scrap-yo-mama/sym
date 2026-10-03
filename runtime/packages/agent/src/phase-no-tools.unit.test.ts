// SPDX-License-Identifier: AGPL-3.0-only
// Règle des deux par phase appliquée à TOUTES les phases du LLM (19 §7, PA-01) : enquête, recompilation (réparation) et
// juge ont un registre d'outils VIDE (`toolRegistryForPhase`) ; même un modèle dont le profil ne propose que la sortie
// structurée par outil forcé (S2) ne reçoit AUCUN outil : la requête ne porte ni `tools` ni `tool_choice`.
import { healthyProfile, Secret, toolRegistryForPhase, validateDeclarativeSpec, type DeclarativeSpec } from '@runtime/core';
import { createLlmClient, type CapabilityProfile } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { proposeInvestigation } from './investigate.js';
import { proposeJudgement } from './judge.js';
import { proposeRepair, type RepairArgs } from './repair.js';

const profile = (model: string): CapabilityProfile => ({
  model,
  tools: true,
  tool_choice: ['auto', 'required', 'named'],
  structured_modes: ['tool_forced'],
  structured: 'tool_forced',
  stream_tools: null,
  stream_usage: null,
  cache: false,
  reasoning_field: null,
  probed_at: '2026-10-01T00:00:00Z',
  probe_tokens: 0,
  notes: [],
});

let fake: FakeProvider;
beforeAll(async () => {
  fake = await createFakeProvider();
});
afterAll(async () => fake?.close());

const clientFor = (role: 'investigate' | 'repair' | 'judge') =>
  createLlmClient({
    providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz-test-key-0000'), models: [{ id: `zz_${role}`, profile: profile(`zz_${role}`), price: { in: 1, out: 1 } }] }],
    roles: { [role]: { provider: 'fake', model: `zz_${role}` } },
  });

const OUT = { type: 'object', required: ['name'], properties: { name: { type: 'string' } }, additionalProperties: false };
function spec(): DeclarativeSpec {
  const check = validateDeclarativeSpec(
    {
      schema_version: 1,
      kind: 'declarative',
      request: { method: 'GET', url: 'https://zz-test.example/api/contacts', allowed_hosts: ['zz-test.example'] },
      sources: [{ id: 'api', from: 'response', format: 'json', records: '$.items[*]' }],
      fields: { name: { path: '$.name', type: 'string', required: true } },
    },
    { outputSchema: OUT },
  );
  if (!check.ok) throw new Error('spec');
  return check.spec;
}

describe('assert_rule_of_two_by_phase : aucun outil offert dans les phases sans outil (enquête, recompilation, juge)', () => {
  it('registres vides', () => {
    for (const phase of ['investigation', 'recompile', 'judge'] as const) expect(toolRegistryForPhase(phase).tools).toEqual([]);
  });

  it('enquête : ni tools ni tool_choice, même avec un profil S2', async () => {
    fake.reset();
    const good = { fields: [{ name: 'id', type: 'string', required: true, personal: false, description: 'Id' }], sources: [] };
    fake.setScenario('zz_investigate', [scripted.json(good)]);
    await proposeInvestigation(clientFor('investigate'), { description: 'x', candidates: [] });
    const body = fake.calls[0]!.body as { tools?: unknown; tool_choice?: unknown };
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('recompilation (réparation) : ni tools ni tool_choice, même avec un profil S2', async () => {
    fake.reset();
    fake.setScenario('zz_repair', [scripted.json({ patch: [] })]);
    const args: RepairArgs = {
      spec: spec(),
      outputSchema: OUT,
      failure: { failure_class: 'extraction', retryable: false, detail: 'schema_mismatch' },
      evidence: [],
      healthy: healthyProfile(Array.from({ length: 6 }, () => ({ name: 'Zztest Valeur Saine' }))),
      reasons: [{ keyword: 'required', instance_path: '/name', count: 20 }],
      refused: [],
    };
    await proposeRepair(clientFor('repair'), args).catch(() => undefined);
    const body = fake.calls[0]!.body as { tools?: unknown; tool_choice?: unknown };
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('juge : ni tools ni tool_choice, même avec un profil S2', async () => {
    fake.reset();
    fake.setScenario('zz_judge', [scripted.json({ flag: false, verdicts: [] })]);
    await proposeJudgement(clientFor('judge'), { schema: OUT, profile: { fields: {} } as never, items: [{ name: 'Chaise' }] }).catch(() => undefined);
    const body = fake.calls[0]!.body as { tools?: unknown; tool_choice?: unknown };
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});
