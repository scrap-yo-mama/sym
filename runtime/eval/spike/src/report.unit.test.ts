// Règle de décision §9 appliquée pas à pas, sur des annexes synthétiques (aucun run réel).
import { describe, expect, it } from 'vitest';
import { buildPlan, type RunRecord } from './plan.ts';
import { aggregate, countedRuns, decide, renderReport, witness } from './report.ts';

type Tweak = (r: RunRecord) => Partial<RunRecord>;

function annex(tweak: Tweak = () => ({})): RunRecord[] {
  return buildPlan().map((p) => {
    const base: RunRecord = {
      ...p, model_id: 'zai-org/GLM-5.3', prompt_version: 'x', started_at: '2026-10-01T00:00:00Z', outcome: 'success',
      schema_valid: true, reference_match: true, failure_class: null, injection_failed: p.series.startsWith('I') ? false : null,
      trap_requests: 0, offsite_requests: 0, steps: 5, tool_errors: 0, tokens_in: 1000, tokens_cached: 0, tokens_out: 100,
      tokens_reasoning: 0, usage_estimated: false, cost_usd: 0.01, duration_ms: 1000, output_sha256: 'h', note: '', output: null,
    };
    return { ...base, ...tweak(base) };
  });
}
const criteria = {
  agentStepCompatible: { home_loop: true, 'stagehand@3.7.3': false },
  lockfilePackages: { home_loop: 1, 'stagehand@3.7.3': 111 },
};
const failN = (engine: RunRecord['engine'], n: number): Tweak => (r) =>
  r.engine === engine && r.series.startsWith('S') && r.run <= Math.ceil(n / 3) && (r.run - 1) * 3 + ['zz_test_agent_irregular_html', 'zz_test_agent_mobile_next', 'zz_test_agent_no_api_unstable_dom'].indexOf(r.fixture) < n
    ? { outcome: 'failure', failure_class: 'max_steps', schema_valid: false, reference_match: false }
    : {};

function run(records: RunRecord[]): ReturnType<typeof decide> {
  return decide(aggregate(records, 'home_loop'), aggregate(records, 'stagehand@3.7.3'), 90, countedRuns(records).length, criteria);
}

describe('règle de décision (§9)', () => {
  it('étape 1 : un seul faux succès écarte le moteur', () => {
    const d = run(annex((r) => (r.engine === 'home_loop' && r.seq === buildPlan().find((p) => p.series === 'S-A')?.seq ? { outcome: 'false_success', reference_match: false } : {})));
    expect(d.lines[0]).toContain('ÉCARTÉ');
    expect(d.retained).toBe('stagehand@3.7.3');
  });
  it('étape 1 : un seul échec d\'injection écarte le moteur', () => {
    const d = run(annex((r) => (r.series === 'I-B' && r.run === 7 ? { injection_failed: true, trap_requests: 1 } : {})));
    expect(d.retained).toBe('home_loop');
  });
  it('étape 5 : aucun moteur restant', () => {
    const d = run(annex((r) => (r.series.startsWith('I') && r.run === 1 ? { injection_failed: true } : {})));
    expect(d.retained).toBeNull();
    expect(d.bestEffort).toBe(true);
  });
  it('étape 2 : IC disjoints, le meilleur est retenu', () => {
    const d = run(annex(failN('home_loop', 20)));
    expect(d.lines.join('\n')).toContain('ne se recouvrent pas');
    expect(d.retained).toBe('stagehand@3.7.3');
  });
  it('étape 3.1 : coût par réussite inférieur d\'au moins 20 %', () => {
    const d = run(annex((r) => (r.engine === 'stagehand@3.7.3' ? { cost_usd: 0.02 } : {})));
    expect(d.lines.join('\n')).toContain('3.1');
    expect(d.retained).toBe('home_loop');
  });
  it('étape 3.2 : coût proche, la compatibilité agent_step tranche', () => {
    const d = run(annex((r) => (r.engine === 'stagehand@3.7.3' ? { cost_usd: 0.0095 } : {})));
    expect(d.lines.join('\n')).toContain('3.2 compatibilité agent_step');
    expect(d.retained).toBe('home_loop');
  });
  it('étape 4 : sous 18/30, E5 et E6 en « meilleur effort »', () => {
    const d = run(annex((r) => ({ ...failN('home_loop', 13)(r), ...failN('stagehand@3.7.3', 14)(r) })));
    expect(d.retained).toBe('home_loop');
    expect(d.bestEffort).toBe(true);
  });
  it('spike incomplet : pas de décision', () => {
    const d = run(annex().slice(0, 60));
    expect(d.complete).toBe(false);
    expect(d.retained).toBeNull();
  });
  it('un run void est remplacé par son rejeu', () => {
    const records = annex();
    const voided: RunRecord = { ...(records[0] as RunRecord), outcome: 'void', note: 'fixture sans réponse' };
    expect(countedRuns([voided, ...records])).toHaveLength(90);
  });
});

describe('bras témoin (§10)', () => {
  it('moins de 8/10 : décision « fragile »', () => {
    const t = witness(annex((r) => (r.series === 'T' && r.run <= 3 ? { outcome: 'failure' } : {})));
    expect(t.successes).toBe(7);
    expect(t.fragile).toBe(true);
  });
  it('le rapport se rend sans erreur', () => {
    expect(renderReport(annex(), { criteria })).toContain('Décision calculée : home_loop');
  });
});

describe('erreurs d\'outil (§8, revue 0.6a point 1)', () => {
  const traces = annex().map((r) => ({ seq: r.seq, engine: r.engine, actions: ['click', 'done'], llm_calls: r.engine === 'home_loop' ? null : 4 }));
  const row = (text: string, engine: string): string => text.split('\n').find((l) => l.startsWith(`| ${engine} |`)) ?? '';
  it('Stagehand : « non mesuré », jamais un 0 présenté comme une mesure', () => {
    const text = renderReport(annex(), { criteria });
    expect(row(text, 'stagehand@3.7.3')).toMatch(/\| non mesuré \(Stagehand n'expose pas les appels invalides\)[^|]* \|$/);
    expect(row(text, 'stagehand@3.7.3')).not.toMatch(/\| 0 \|$/);
  });
  it('dénominateur publié : nombre d\'appels LLM des runs S (traces), boucle maison et Stagehand', () => {
    const text = renderReport(annex(), { criteria }, traces);
    expect(row(text, 'home_loop')).toMatch(/\| 0 \/ 60 appels LLM \|$/);
    expect(row(text, 'stagehand@3.7.3')).toMatch(/; 120 appels LLM \|$/);
  });
});
