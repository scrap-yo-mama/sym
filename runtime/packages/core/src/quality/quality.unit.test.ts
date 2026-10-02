// SPDX-License-Identifier: AGPL-3.0-only
// Profil des sorties, motifs dégradés, contenu minimal, juge consultatif (tâche 2.12, 19 §3, 19b §4).
import { afterEach, describe, expect, test, vi } from 'vitest';
import { applyStatusEvent, initialStatusState } from '../status/index.js';
import { TRANSITIONS } from '../status/transitions.js';
import {
  applyJudgement,
  DEGRADED_QUALITY_SIGNALS,
  degradedQualitySignals,
  JUDGE_VERDICT_SCHEMA,
  judgeDecision,
  judgeSampleItems,
  minimalContentCheck,
  parseJudgement,
  profileItems,
  SENTINEL_VALUES,
  selectJudgeSample,
} from './index.js';

const SCHEMA = {
  type: 'object',
  required: ['sku', 'title', 'price', 'currency'],
  properties: {
    sku: { type: 'string' },
    title: { type: 'string' },
    price: { type: 'number' },
    currency: { type: 'string', constant_ok: true },
    state: { type: 'string' },
    email: { type: 'string', 'x-personal': true },
    contact: { type: 'string' },
  },
};

const item = (i: number, over: Record<string, unknown> = {}) => ({
  sku: `ZZ-${String(i).padStart(4, '0')}`,
  title: `Chaise ${i}`,
  price: 10 + i,
  currency: 'EUR',
  state: i % 2 === 0 ? 'neuf' : 'occasion',
  email: `zz.person${i}@example.test`,
  contact: 'Écrire à zz.contact@example.test',
  ...over,
});
const items = (n: number, over: (i: number) => Record<string, unknown> = () => ({})) => Array.from({ length: n }, (_, i) => item(i, over(i)));

afterEach(() => vi.restoreAllMocks());

describe('profileItems (r4 R1, R2)', () => {
  test('assert_profile_no_llm — fonction pure : 0 appel LLM, 0 requête réseau ; remplissage, sentinelles, motifs, longueurs, unicité, doublons', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const p = profileItems([...items(10), item(0)], SCHEMA);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(p.items).toBe(11);
    expect(p.duplicates).toBe(1);
    expect(p.fields['sku']).toMatchObject({ fill_rate: 1, sentinel_rate: 0, top_pattern: 'A-9' });
    expect(p.fields['sku']!.unique_rate).toBeCloseTo(10 / 11, 3);
    expect(p.fields['title']!.length.min).toBeGreaterThan(0);
    expect(p.fields['price']).toMatchObject({ type: 'number', min: 10, max: 19 });
    expect(p.fields['currency']).toMatchObject({ constant: true });
    // Fonction pure : même entrée, même profil.
    expect(profileItems([...items(10), item(0)], SCHEMA)).toEqual(p);
  });

  test('x-personal : formes seulement (ni min, ni max, ni top-k, ni exemple) ; ≥ 20 % d’e-mails ou téléphones → suspected_personal', () => {
    const p = profileItems(items(10), SCHEMA);
    const email = p.fields['email']!;
    expect(email.personal).toBe(true);
    expect(email).not.toHaveProperty('top');
    expect(email).not.toHaveProperty('min');
    expect(email).not.toHaveProperty('max');
    expect(email.top_pattern).not.toContain('zz');
    expect(p.fields['contact']!.suspected_personal).toBe(true);
    expect(p.fields['contact']).not.toHaveProperty('top');
    expect(JSON.stringify(p)).not.toMatch(/zz\.person|zz\.contact/);
  });
});

describe('motifs de run dégradé, sans nouvelle transition (r4 R4)', () => {
  const baseline = profileItems(items(20), SCHEMA);

  test('assert_degraded_signals_no_new_transition — les 5 motifs provoqués ; transitions 5 ou 8 ; aucune transition nouvelle', () => {
    expect(DEGRADED_QUALITY_SIGNALS).toEqual(['field_constant', 'pattern_shift', 'sentinel_values', 'duplicate_items', 'new_enum_value']);
    const cases: Record<string, Record<string, unknown>[]> = {
      field_constant: items(20, () => ({ title: 'Chaise' })),
      pattern_shift: items(20, (i) => ({ sku: `zz${i}x` })),
      sentinel_values: items(20, (i) => (i < 10 ? { title: 'N/A' } : {})),
      duplicate_items: [...items(10), ...items(10)],
      new_enum_value: items(20, (i) => (i === 3 ? { state: 'reconditionné' } : {})),
    };
    for (const [signal, run] of Object.entries(cases)) {
      const found = degradedQualitySignals(profileItems(run, SCHEMA), baseline, SCHEMA);
      expect(found, signal).toContain(signal);
    }
    // Run sain contre sa baseline : aucun motif.
    expect(degradedQualitySignals(profileItems(items(20), SCHEMA), baseline, SCHEMA)).toEqual([]);
    // Baseline non validée : seuls les contrôles absolus (constante, sentinelles, doublons).
    expect(degradedQualitySignals(profileItems(cases['pattern_shift']!, SCHEMA), null, SCHEMA)).not.toContain('pattern_shift');
    expect(degradedQualitySignals(profileItems(cases['new_enum_value']!, SCHEMA), null, SCHEMA)).not.toContain('new_enum_value');
    expect(degradedQualitySignals(profileItems(cases['duplicate_items']!, SCHEMA), null, SCHEMA)).toContain('duplicate_items');

    // Les motifs passent par les transitions 5 et 8 existantes ; le nombre de transitions ne change pas (21, 22 après 3.14).
    const clock = { now: () => new Date('2026-10-02T12:00:00Z') };
    let state = { ...initialStatusState(), status: 'sain' as const };
    for (const signal of DEGRADED_QUALITY_SIGNALS) {
      const step = applyStatusEvent(state, { type: 'run_succeeded', signals: [signal] }, { clock });
      expect(step.ok, signal).toBe(true);
      if (!step.ok) continue;
      expect([5, 8]).toContain(step.transitions[0]!.transition);
      expect(step.transitions[0]!.reason).toBe(signal);
      state = step.state as typeof state;
    }
    for (const signal of DEGRADED_QUALITY_SIGNALS) {
      const owners = TRANSITIONS.filter((t) => t.reasons.includes(signal)).map((t) => t.id);
      expect(owners, signal).toEqual([5, 8]);
    }
    expect(TRANSITIONS.length).toBeLessThanOrEqual(22);
    expect(new Set(TRANSITIONS.map((t) => t.id)).size).toBe(TRANSITIONS.length);
  });
});

describe('contenu minimal à l’enquête (r4 R5)', () => {
  test('assert_minimal_content_guard — champ requis toujours N/A sur les 3 sorties → extraction ; constant_ok accepté', () => {
    const na = [items(5, () => ({ title: 'N/A' })), items(5, () => ({ title: 'N/A' })), items(5, () => ({ title: 'N/A' }))];
    expect(minimalContentCheck(na, SCHEMA)).toEqual({ ok: false, failure_class: 'extraction', detail: 'minimal_content', field: 'title', reason: 'sentinel' });
    const empty = [items(3, () => ({ sku: '' })), items(3, () => ({ sku: '' })), items(3, () => ({ sku: '' }))];
    expect(minimalContentCheck(empty, SCHEMA)).toMatchObject({ ok: false, field: 'sku', reason: 'sentinel' });
    const constant = [items(3, () => ({ title: 'Toujours pareil' })), items(3, () => ({ title: 'Toujours pareil' })), items(3, () => ({ title: 'Toujours pareil' }))];
    expect(minimalContentCheck(constant, SCHEMA)).toMatchObject({ ok: false, field: 'title', reason: 'constant' });
    // Devise EUR partout : constant_ok, accepté.
    expect(minimalContentCheck([items(3), items(3), items(3)], SCHEMA)).toEqual({ ok: true });
    for (const s of ['N/A', 'n/a', '-', '—', 'null', 'undefined', '']) expect(SENTINEL_VALUES).toContain(s);
  });
});

describe('juge consultatif (arbitrage n° 3, r4 R6 à R10)', () => {
  test('échantillon choisi par le code : 3 à 5 items, graine journalisée, dernier item compris', () => {
    const run = items(30);
    const a = selectJudgeSample(run, profileItems(run, SCHEMA), { seed: 'zz-seed', size: 4 });
    const b = selectJudgeSample(run, profileItems(run, SCHEMA), { seed: 'zz-seed', size: 4 });
    expect(a).toEqual(b);
    expect(a.indices.length).toBe(4);
    expect(a.indices).toContain(29);
    expect(a.seed).toBe('zz-seed');
  });

  test('échantillon (19 §3) : un item de la baseline validée quand elle existe, 5 items au plus', () => {
    const run = items(30);
    const profile = profileItems(run, SCHEMA);
    const baselineItem = { sku: 'ZZ-BASELINE', title: 't', price: 1, currency: 'EUR' };
    const withBase = judgeSampleItems(run, profile, { seed: 'zz-seed', size: 5, baselineItem });
    expect(withBase.items.length).toBeLessThanOrEqual(5);
    expect(withBase.items.at(-1)).toEqual(baselineItem);
    expect(withBase.baseline).toBe(true);
    expect(withBase.items).toContainEqual(run[29]);
    const without = judgeSampleItems(run, profile, { seed: 'zz-seed', size: 4 });
    expect(without.baseline).toBe(false);
    expect(without.items).toEqual(selectJudgeSample(run, profile, { seed: 'zz-seed', size: 4 }).indices.map((i) => run[i]));
  });

  test('sortie validée (raison ≤ 200, verdict fermé) ; illisible → aucun drapeau', () => {
    expect(JUDGE_VERDICT_SCHEMA.properties.verdicts.items.properties.reason.maxLength).toBe(200);
    expect(parseJudgement({ verdicts: [{ field: 'price', verdict: 'wrong', indices: [1], reason: 'x'.repeat(300) }] })).toBeNull();
    expect(parseJudgement({ verdicts: [{ field: 'price', verdict: 'maybe', indices: [], reason: '' }] })).toBeNull();
    expect(parseJudgement({ verdicts: [{ field: 'price', verdict: 'wrong', indices: [1], reason: 'prix à 0' }] })).toEqual({ flag: true, verdicts: [{ field: 'price', verdict: 'wrong', indices: [1], reason: 'prix à 0' }] });
  });

  test('assert_judge_advisory_only — un juge qui dit « wrong » partout ne pose que judge_flag ; statut, version, schéma et règles inchangés', () => {
    const before = { status: 'sain', current_strategy_version: 3, output_schema: SCHEMA, rules: ['zz@1'] } as const;
    for (const trigger of ['investigation', 'repair', 'anomaly'] as const) {
      const verdicts = Object.keys(SCHEMA.properties).map((field) => ({ field, verdict: 'wrong' as const, indices: [0], reason: 'faux' }));
      const out = applyJudgement({ trigger, judgement: { flag: true, verdicts } });
      expect(out).toEqual({ judge: { flag: true, verdicts, trigger }, reasons: ['judge_flag'] });
      expect(Object.keys(out).sort()).toEqual(['judge', 'reasons']);
      expect(before).toEqual({ status: 'sain', current_strategy_version: 3, output_schema: SCHEMA, rules: ['zz@1'] });
    }
  });

  test('désactivé par défaut ; sur anomalie, un jugement par API et par jour', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    expect(judgeDecision({ enabled: false, trigger: 'investigation', lastJudgedAt: null, now })).toBe(false);
    expect(judgeDecision({ enabled: true, trigger: 'investigation', lastJudgedAt: now, now })).toBe(true);
    expect(judgeDecision({ enabled: true, trigger: 'anomaly', lastJudgedAt: new Date('2026-10-02T01:00:00Z'), now })).toBe(false);
    expect(judgeDecision({ enabled: true, trigger: 'anomaly', lastJudgedAt: new Date('2026-10-01T11:00:00Z'), now })).toBe(true);
  });
});
