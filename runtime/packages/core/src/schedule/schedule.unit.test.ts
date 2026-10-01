// SPDX-License-Identifier: AGPL-3.0-only
// Règles de planification (08 § 5) : analyse stricte, décision pure, variables datées. Étage U1.
import { describe, expect, test } from 'vitest';
import { evaluateScheduleRules, inWindow, localParts, parseScheduleRules, resolveScheduleInput, scheduleDates, type RuleContext, type ScheduleRules } from './index.js';

function rules(raw: unknown = {}): ScheduleRules {
  const parsed = parseScheduleRules(raw);
  if (!parsed.ok) throw new Error(parsed.errors.join('; '));
  return parsed.rules;
}

const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  now: new Date('2026-10-01T10:00:00Z'),
  timezone: 'UTC',
  enabled: true,
  overlap: 'skip',
  apiStatus: 'sain',
  tunnelOnline: true,
  apiRequiresTunnel: false,
  runsToday: 0,
  activeRun: false,
  ...over,
});

describe('parseScheduleRules', () => {
  test('défaut : skip_if_status_in = [erreur, action_requise, bloquee]', () => {
    expect(rules().skip_if_status_in).toEqual(['erreur', 'action_requise', 'bloquee']);
    expect(rules(null).skip_if_status_in).toEqual(['erreur', 'action_requise', 'bloquee']);
  });

  test('règles complètes acceptées', () => {
    const r = rules({
      only_if_tunnel_online: true,
      window: { start: '08:00', end: '20:00' },
      max_runs_per_day: 4,
      skip_if_status_in: ['bloquee', 'erreur', 'warning'],
      dedup_key: 'item.url',
      diff: 'new',
      alert_on: ['new_items', 'error'],
    });
    expect(r).toMatchObject({ only_if_tunnel_online: true, max_runs_per_day: 4, dedup_key: 'item.url', diff: 'new' });
    expect(r.skip_if_status_in).toEqual(['bloquee', 'erreur', 'warning']);
  });

  test.each([
    [{ inconnue: 1 }, 'règle inconnue'],
    [{ window: { start: '8h', end: '20:00' } }, 'window'],
    [{ window: { start: '08:00', end: '08:00' } }, 'identiques'],
    [{ max_runs_per_day: 0 }, 'max_runs_per_day'],
    [{ max_runs_per_day: 1.5 }, 'max_runs_per_day'],
    [{ skip_if_status_in: ['erreur'] }, 'bloquee'],
    [{ skip_if_status_in: [] }, 'bloquee'],
    [{ skip_if_status_in: ['nimporte'] }, 'skip_if_status_in'],
    [{ diff: 'new' }, 'dedup_key'],
    [{ diff: 'tout', dedup_key: 'url' }, 'diff'],
    [{ dedup_key: 'url; DROP' }, 'dedup_key'],
    [{ alert_on: ['sms'] }, 'alert_on'],
    ['texte', 'objet attendu'],
  ])('refus : %j', (raw, fragment) => {
    const parsed = parseScheduleRules(raw);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors.join(' ')).toContain(fragment);
  });
});

describe('evaluateScheduleRules', () => {
  test('API saine, rien qui bloque : run', () => {
    expect(evaluateScheduleRules(rules(), ctx())).toEqual({ action: 'run' });
  });

  test('désactivée : aucun run tracé', () => {
    expect(evaluateScheduleRules(rules(), ctx({ enabled: false }))).toEqual({ action: 'ignore', reason: 'disabled' });
  });

  test.each(['erreur', 'action_requise', 'bloquee'] as const)('statut %s : skipped_status', (apiStatus) => {
    expect(evaluateScheduleRules(rules(), ctx({ apiStatus }))).toMatchObject({ action: 'skip', state: 'skipped_status' });
  });

  test('bloquee est toujours sautée, même si la ligne écrite hors du service omet la règle', () => {
    const forged: ScheduleRules = { ...rules(), skip_if_status_in: [] };
    expect(evaluateScheduleRules(forged, ctx({ apiStatus: 'bloquee' }))).toMatchObject({ action: 'skip', state: 'skipped_status' });
  });

  test('warning et sain passent par défaut ; une liste étendue saute warning', () => {
    expect(evaluateScheduleRules(rules(), ctx({ apiStatus: 'warning' }))).toEqual({ action: 'run' });
    expect(evaluateScheduleRules(rules({ skip_if_status_in: ['bloquee', 'warning'] }), ctx({ apiStatus: 'warning' }))).toMatchObject({ state: 'skipped_status' });
  });

  test('tunnel : règle ou requires.tunnel → skipped_tunnel_offline ; en ligne → run', () => {
    expect(evaluateScheduleRules(rules({ only_if_tunnel_online: true }), ctx({ tunnelOnline: false }))).toMatchObject({ state: 'skipped_tunnel_offline' });
    expect(evaluateScheduleRules(rules(), ctx({ tunnelOnline: false, apiRequiresTunnel: true }))).toMatchObject({ state: 'skipped_tunnel_offline' });
    expect(evaluateScheduleRules(rules(), ctx({ tunnelOnline: false }))).toEqual({ action: 'run' });
    expect(evaluateScheduleRules(rules({ only_if_tunnel_online: true }), ctx())).toEqual({ action: 'run' });
  });

  test('le statut prime sur le tunnel : un site qui a refusé n\'est pas sollicité', () => {
    expect(evaluateScheduleRules(rules({ only_if_tunnel_online: true }), ctx({ apiStatus: 'bloquee', tunnelOnline: false }))).toMatchObject({ state: 'skipped_status' });
  });

  test('fenêtre dans le fuseau de la planification', () => {
    const r = rules({ window: { start: '08:00', end: '12:00' } });
    // 10:00Z = 12:00 à Paris (UTC+2 en octobre) : hors fenêtre à Paris, dedans en UTC.
    expect(evaluateScheduleRules(r, ctx({ timezone: 'UTC' }))).toEqual({ action: 'run' });
    expect(evaluateScheduleRules(r, ctx({ timezone: 'Europe/Paris' }))).toMatchObject({ state: 'skipped_window' });
  });

  test('fenêtre qui passe minuit', () => {
    const w = { start: '22:00', end: '06:00' };
    expect(inWindow(w, new Date('2026-10-01T23:30:00Z'), 'UTC')).toBe(true);
    expect(inWindow(w, new Date('2026-10-01T05:59:00Z'), 'UTC')).toBe(true);
    expect(inWindow(w, new Date('2026-10-01T06:00:00Z'), 'UTC')).toBe(false);
    expect(inWindow(w, new Date('2026-10-01T12:00:00Z'), 'UTC')).toBe(false);
  });

  test('quota journalier', () => {
    const r = rules({ max_runs_per_day: 2 });
    expect(evaluateScheduleRules(r, ctx({ runsToday: 1 }))).toEqual({ action: 'run' });
    expect(evaluateScheduleRules(r, ctx({ runsToday: 2 }))).toMatchObject({ state: 'skipped_quota' });
  });

  test('chevauchement : skip, queue, allow', () => {
    expect(evaluateScheduleRules(rules(), ctx({ activeRun: true, overlap: 'skip' }))).toMatchObject({ state: 'skipped_overlap' });
    expect(evaluateScheduleRules(rules(), ctx({ activeRun: true, overlap: 'queue' }))).toEqual({ action: 'defer', reason: 'overlap' });
    expect(evaluateScheduleRules(rules(), ctx({ activeRun: true, overlap: 'allow' }))).toEqual({ action: 'run' });
    expect(evaluateScheduleRules(rules(), ctx({ activeRun: false, overlap: 'skip' }))).toEqual({ action: 'run' });
  });
});

describe('variables datées', () => {
  test('{{today}} et {{yesterday}} dans le fuseau, y compris au passage de minuit', () => {
    // 22:30Z le 30/09 = 00:30 le 01/10 à Paris.
    const at = new Date('2026-09-30T22:30:00Z');
    expect(scheduleDates(at, 'UTC')).toEqual({ today: '2026-09-30', yesterday: '2026-09-29' });
    expect(scheduleDates(at, 'Europe/Paris')).toEqual({ today: '2026-10-01', yesterday: '2026-09-30' });
    expect(localParts(at, 'Europe/Paris')).toEqual({ date: '2026-10-01', time: '00:30' });
  });

  test('franchissement de mois et d\'année', () => {
    expect(scheduleDates(new Date('2027-01-01T08:00:00Z'), 'UTC').yesterday).toBe('2026-12-31');
    expect(scheduleDates(new Date('2028-03-01T08:00:00Z'), 'UTC').yesterday).toBe('2028-02-29');
  });

  test('remplacement profond ; accolades inconnues intactes ; entrée d\'origine non modifiée', () => {
    const input = { since: '{{yesterday}}', until: '{{ today }}', nested: [{ q: 'du {{yesterday}} au {{today}}' }], other: '{{secret}}', n: 3 };
    const out = resolveScheduleInput(input, new Date('2026-10-01T10:00:00Z'), 'UTC');
    expect(out).toEqual({ since: '2026-09-30', until: '2026-10-01', nested: [{ q: 'du 2026-09-30 au 2026-10-01' }], other: '{{secret}}', n: 3 });
    expect(input.since).toBe('{{yesterday}}');
  });
});
