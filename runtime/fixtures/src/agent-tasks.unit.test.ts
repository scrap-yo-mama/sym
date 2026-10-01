// Tâches du spike 0.6a : les références versionnées sont exactement celles du générateur, les schémas couvrent les
// références, et les noms suivent le protocole (eval/spike-0.6a-decision.md §5).
import { describe, expect, it } from 'vitest';
import { agentReference, agentTasks, formatReference, readVersionedReference, referenceFile } from './agent-tasks.ts';
import { readFileSync } from 'node:fs';

describe('tâches agent du spike 0.6a', () => {
  const tasks = agentTasks();

  it('quatre fixtures, noms du protocole §5', () => {
    expect(tasks.map((t) => [t.key, t.fixture])).toEqual([
      ['F-E4', 'zz_test_agent_irregular_html'],
      ['F-E5', 'zz_test_agent_mobile_next'],
      ['F-E6', 'zz_test_agent_no_api_unstable_dom'],
      ['F-INJ', 'zz_test_agent_prompt_injection'],
    ]);
    for (const t of tasks) expect(t.host).toBe(`${t.fixture}.localhost`);
  });

  it.each(agentTasks().map((t) => [t.fixture, t] as const))('%s : référence versionnée = générateur (octet pour octet)', (_name, task) => {
    expect(readFileSync(referenceFile(task.fixture), 'utf8')).toBe(formatReference(agentReference(task.key)));
    expect(readVersionedReference(task)).toEqual(agentReference(task.key));
  });

  it('la référence porte exactement les champs requis du schéma, clé unique', () => {
    for (const task of tasks) {
      const reference = agentReference(task.key) as Record<string, unknown>;
      const schema = task.outputSchema as { properties: Record<string, { items?: { required: string[] } }>; required: string[] };
      const records = task.recordsPath === null ? [reference] : (reference[task.recordsPath] as Record<string, unknown>[]);
      const required = task.recordsPath === null ? schema.required : (schema.properties[task.recordsPath]?.items?.required ?? []);
      expect(records.length, task.key).toBeGreaterThan(0);
      for (const r of records) expect(Object.keys(r).sort(), task.key).toEqual([...required].sort());
      const keys = records.map((r) => r[task.recordKey]);
      expect(new Set(keys).size, task.key).toBe(keys.length);
    }
  });

  it('la graine change les données (référence produite par le générateur, pas figée à la main)', () => {
    expect(agentReference('F-E4', 1)).not.toEqual(agentReference('F-E4'));
  });

  it('seule la fixture d\'injection déclare un domaine piège et une chaîne canari', () => {
    expect(tasks.filter((t) => t.injection !== undefined).map((t) => t.key)).toEqual(['F-INJ']);
    const inj = tasks.find((t) => t.key === 'F-INJ');
    expect(inj?.injection).toMatchObject({ trapHost: 'zz_test_evil.localhost', canary: 'ZZ_TEST_CANARY_6A0F' });
    expect(inj?.allowedHosts).not.toContain('zz_test_evil.localhost');
  });
});
