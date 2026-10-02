// SPDX-License-Identifier: AGPL-3.0-only
// Reprise par étape et agent instruit dans la console (19 § 4, 19b § 3 et § 4, tâche 2.13), contre l'OpenAPI spécifiée et
// son client généré (le serveur REST de ces routes n'est pas encore livré) : panneau « Reprises » d'un run (étape,
// niveau, issue, coût, jetons, diff, badge), libellé « agent instruit » avec le coût par run et rappel avant chaque
// lancement, confirmation des étapes instruites, opt-in refusé sans confirmation, intentions non fiables rendues en texte.
import { effectScope, type EffectScope } from 'vue';
import { afterEach, describe, expect, test } from 'vitest';
import type { components } from '@runtime/client';
import ApiDetailPage from '@/components/api/ApiDetailPage.vue';
import InstructedStepsPanel from '@/components/api/InstructedStepsPanel.vue';
import LaunchForm from '@/components/api/LaunchForm.vue';
import RunRepairsPanel from '@/components/api/RunRepairsPanel.vue';
import ApiOverviewTab from '@/components/api/tabs/ApiOverviewTab.vue';
import { useApiRuns } from '@/composables/useApiRuns';
import { useInstructedMode } from '@/composables/useInstructedMode';
import { loadSession, resetSession } from '@/composables/useSession';
import en from '@/i18n/locales/en.json';
import fr from '@/i18n/locales/fr.json';
import { setApi } from '@/lib/api';
import { isStepReasonCode, STEP_REASON_ACTIONS, STEP_REASON_CODES } from '@/lib/reasons';
import { instructedOffered, patchLines, stepAttempts } from '@/lib/step-repairs';
import { apiDetail, controls, installApi, json, renderHtml, textOf, UUID } from '@/testing/console-fixtures';
import { ME } from '@/testing/console.testkit';

type Schemas = components['schemas'];

const SLUG = 'zz-steps';
const OWNER = UUID(2);
const XSS = '<img src=x onerror=alert(1)>';
const SHA = 'a'.repeat(64);

const scopes: EffectScope[] = [];
function inScope<T>(run: () => T): T {
  const scope = effectScope();
  scopes.push(scope);
  return scope.run(run) as T;
}
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
  setApi(undefined);
  resetSession();
});

const attempt = (index: number, overrides: Partial<Schemas['RunAttempt']> = {}): Schemas['RunAttempt'] => ({
  index,
  execution: 'playwright',
  network: 'direct',
  state: 'done',
  est_cost_usd: 0,
  result: 'ok',
  cost_usd: 0,
  ms: 900,
  step_id: null,
  step_level: null,
  step_outcome: null,
  step_patch: null,
  ...overrides,
});

const summary = (overrides: Partial<Schemas['RunSummary']> = {}): Schemas['RunSummary'] => ({
  id: UUID(201),
  api_id: UUID(1),
  api_slug: SLUG,
  owner_id: OWNER,
  strategy_version: 4,
  trigger: 'schedule',
  state: 'succeeded',
  outcome: 'degraded',
  degraded_reasons: ['repaired'],
  failure_class: null,
  created_at: '2026-10-01T09:00:00.000Z',
  started_at: '2026-10-01T09:00:01.000Z',
  finished_at: '2026-10-01T09:00:09.000Z',
  duration_ms: 8000,
  cost: { llm_usd: 0.018, proxy_usd: 0, total_usd: 0.019, estimated: false },
  items: 20,
  dataset_id: UUID(301),
  ...overrides,
});

/** Run réparé à l'étape 3 (`s3`) : essai de la cascade, niveau 1 en échec, niveau 3 réparé par l'agent, conforme au client généré. */
const repairedRun = (overrides: Partial<Schemas['Run']> = {}): Schemas['Run'] => ({
  ...summary(),
  metadata_only: false,
  tokens: { in: 4200, cached: 0, out: 310, reasoning: 0, estimated: false },
  repaired_automatically: true,
  attempts: [
    attempt(0, { result: 'extraction' }),
    attempt(1, { step_id: 's3', step_level: 1, step_outcome: 'failed', result: 'extraction', cost_usd: 0 }),
    attempt(2, {
      step_id: 's3',
      step_level: 3,
      step_outcome: 'agent_repaired',
      execution: 'agent',
      cost_usd: 0.018,
      tokens: { in: 4200, cached: 1000, out: 300, reasoning: 10, estimated: false },
      step_patch: [
        { op: 'replace', path: '/steps/2/target', value: { role: 'button', name: 'Page suivante' } },
        { op: 'add', path: '/steps/2/target/alternates/-', value: { text: 'Suivant' } },
      ],
    }),
  ],
  ...overrides,
});

const instructed = (overrides: Partial<Schemas['InstructedSteps']> = {}): Schemas['InstructedSteps'] => ({
  version: 4,
  compilable: 'no',
  steps: [
    { id: 's1', intent: 'Ouvrir la liste des annonces', post: [{ kind: 'url_contains', value: '/annonces' }] },
    { id: 's2', intent: 'Cliquer sur « Page suivante »', post: [{ kind: 'element_present', role: 'list', name: 'Annonces' }] },
  ],
  sha256: SHA,
  confirmed_by: null,
  confirmed_at: null,
  estimated_run_usd: 0.04,
  ...overrides,
});

const usd = (value: number, locale: 'fr' | 'en' = 'fr', estimated = false): string =>
  `${estimated ? '~' : ''}${new Intl.NumberFormat(locale, { minimumFractionDigits: 0, maximumFractionDigits: 4 }).format(value)} $`;

async function signIn(routes: Parameters<typeof installApi>[0] = {}): Promise<string[]> {
  const seen = installApi({
    'GET /api/auth/get-session': () => json(200, { session: { id: 's' }, user: { id: OWNER, email: 'zz@x.test' } }),
    'GET /api/me': () => json(200, { ...ME, id: OWNER }),
    ...routes,
  });
  resetSession();
  await loadSession();
  return seen;
}

describe('panneau « Reprises » d’un run (19 § 4, r2 R12)', () => {
  test('console : un run réparé à l’étape 3 montre niveau, coût et badge', async () => {
    const seen = await signIn({ [`GET /api/runs/${UUID(201)}`]: () => json(200, repairedRun()) });
    const runs = inScope(() => useApiRuns(SLUG, { immediate: false }));
    expect(await runs.showRepairs(summary())).toBe(true);
    expect(seen).toContain(`GET /api/runs/${UUID(201)}`);
    const run = runs.repairsRun.value;
    expect(run).not.toBeNull();

    const html = await renderHtml(RunRepairsPanel, { run });
    // Une ligne par essai dont l'étape est connue : l'essai de la cascade (step_id null) n'en a pas.
    const rows = [...html.matchAll(/<tr[^>]*data-testid="run-repair-row"[^>]*>([\s\S]*?)<\/tr>/g)];
    expect(rows).toHaveLength(2);
    const level3 = rows.find((row) => row[0].includes('data-level="3"'))?.[1] ?? '';
    expect(textOf(level3)).toContain('s3');
    expect(textOf(level3)).toContain(fr.repairs.level[3]);
    expect(textOf(level3)).toContain(fr.repairs.outcome.agent_repaired);
    expect(textOf(level3)).toContain(usd(0.018));
    // Jetons : entrée, puis sortie et raisonnement.
    const count = (value: number): string => new Intl.NumberFormat('fr').format(value).replace(/\s/g, ' ');
    expect(textOf(level3)).toContain(`${count(4200)} en entrée, ${count(310)} en sortie`);
    // Diff de l'étape : chemins du patch et valeurs en texte.
    expect(textOf(level3)).toContain('/steps/2/target');
    expect(textOf(level3)).toContain('"Page suivante"');
    expect(textOf(level3)).toContain(fr.repairs.op.replace);
    const level1 = rows.find((row) => row[0].includes('data-level="1"'))?.[1] ?? '';
    expect(textOf(level1)).toContain(fr.repairs.level[1]);
    expect(textOf(level1)).toContain(fr.repairs.outcome.failed);
    expect(textOf(level1)).toContain(fr.repairs.noDiff);
    // Badge « réparée automatiquement », écrit en toutes lettres.
    expect(html).toContain('data-testid="repaired-automatically"');
    expect(textOf(html)).toContain(fr.repairs.autoRepaired);

    const english = textOf(await renderHtml(RunRepairsPanel, { run }, 'en'));
    expect(english).toContain(en.repairs.level[3]);
    expect(english).toContain(en.repairs.autoRepaired);
    expect(english).toContain(usd(0.018, 'en'));
  });

  test('sans réparation automatique, pas de badge ; un run sans reprise le dit', async () => {
    const html = await renderHtml(RunRepairsPanel, { run: repairedRun({ repaired_automatically: false, attempts: [attempt(0)] }) });
    expect(html).not.toContain('data-testid="repaired-automatically"');
    expect(html).toContain('data-testid="run-repairs-empty"');
    expect(stepAttempts(repairedRun())).toHaveLength(2);
  });

  test('le run d’un autre membre n’est jamais lu (aucune requête)', async () => {
    const seen = await signIn();
    const runs = inScope(() => useApiRuns(SLUG, { immediate: false }));
    expect(await runs.showRepairs(summary({ owner_id: UUID(99) }))).toBe(false);
    expect(seen.filter((request) => request.startsWith('GET /api/runs/'))).toEqual([]);
  });

  test('les valeurs d’un patch d’étape (lues sur une page) restent du texte', async () => {
    const run = repairedRun({ attempts: [attempt(1, { step_id: 's3', step_level: 2, step_outcome: 'agent_repaired', step_patch: [{ op: 'replace', path: '/steps/2/target', value: { role: 'button', name: XSS } }] })] });
    const html = await renderHtml(RunRepairsPanel, { run });
    expect(html).not.toMatch(/<img\b/i);
    expect(patchLines(run.attempts[0]?.step_patch)[0]?.value).toContain(XSS.replace(/"/g, '\\"'));
  });
});

describe('agent instruit (19 § 4, arbitrage n° 5)', () => {
  test('activer l’agent instruit sans confirmer les étapes laisse instructed_mode: false', async () => {
    let body: unknown;
    const seen = installApi({
      [`PUT /api/apis/${SLUG}/instructed-mode`]: async (request) => {
        body = await request.json();
        return json(409, { error: { code: 'instructed_steps_unconfirmed', message: 'x' } });
      },
    });
    const detail = apiDetail({ slug: SLUG, status: 'erreur', status_reason: { code: 'not_compilable', params: {} }, instructed: instructed() });
    const mode = inScope(() => useInstructedMode(SLUG, detail));
    // Jamais par défaut : sans `instructed_mode`, l'interrupteur est éteint.
    expect(mode.enabled.value).toBe(false);
    expect(await mode.setEnabled(true)).toBeNull();
    expect(body).toEqual({ enabled: true });
    expect(seen).toEqual([`PUT /api/apis/${SLUG}/instructed-mode`]);
    expect(mode.enabled.value).toBe(false);
    expect(mode.error.value?.status).toBe(409);
    expect(mode.error.value?.code).toBe('instructed_steps_unconfirmed');

    // À l'écran : interrupteur éteint, message, et aucun libellé « agent instruit » dans l'en-tête.
    const panel = await renderHtml(InstructedStepsPanel, { instructed: detail.instructed, enabled: mode.enabled.value, pending: mode.pending.value, error: mode.error.value });
    expect(panel).toMatch(/data-testid="instructed-switch"/);
    expect(panel).toMatch(/role="switch"[^>]*aria-checked="false"|aria-checked="false"[^>]*role="switch"/);
    expect(textOf(panel)).toContain(fr.apiErrors.instructed_steps_unconfirmed);
    expect(textOf(panel)).toContain(fr.instructed.off);
    const page = await renderHtml(ApiDetailPage, { detail, slug: SLUG, tab: 'overview', resuming: false });
    expect(page).not.toContain('data-testid="instructed-label"');
    expect(page).toContain('data-testid="instructed-panel"');
    expect(page).not.toContain('data-testid="instructed-cost-reminder"');
  });

  test('« Confirmer ces étapes » envoie la version et l’empreinte reçues ; l’activation suit, le libellé et le coût par run apparaissent', async () => {
    const confirmedSteps = instructed({ confirmed_by: OWNER, confirmed_at: '2026-10-01T10:00:00.000Z' });
    const bodies: unknown[] = [];
    installApi({
      [`POST /api/apis/${SLUG}/instructed-steps/confirm`]: async (request) => {
        bodies.push(await request.json());
        return json(200, apiDetail({ slug: SLUG, status: 'erreur', instructed: confirmedSteps }));
      },
      [`PUT /api/apis/${SLUG}/instructed-mode`]: async (request) => {
        bodies.push(await request.json());
        return json(200, apiDetail({ slug: SLUG, status: 'erreur', instructed_mode: true, instructed: confirmedSteps }));
      },
    });
    const mode = inScope(() => useInstructedMode(SLUG, apiDetail({ slug: SLUG, status: 'erreur', instructed: instructed() })));
    expect((await mode.confirm())?.instructed?.confirmed_by).toBe(OWNER);
    const updated = await mode.setEnabled(true);
    expect(bodies).toEqual([{ version: 4, sha256: SHA }, { enabled: true }]);
    expect(mode.enabled.value).toBe(true);

    const page = await renderHtml(ApiDetailPage, { detail: updated, slug: SLUG, tab: 'overview', resuming: false });
    expect(page).toContain('data-testid="instructed-label"');
    expect(textOf(page)).toContain(fr.instructed.label.replace('{cost}', usd(0.04, 'fr', true)));
    // Rappel du coût avant chaque lancement, avant le bouton Lancer.
    const reminder = page.indexOf('data-testid="instructed-cost-reminder"');
    expect(reminder).toBeGreaterThan(-1);
    expect(reminder).toBeLessThan(page.indexOf('data-testid="launch-submit"'));
    expect(textOf(page)).toContain(fr.launch.instructed.replace('{cost}', usd(0.04, 'fr', true)));
    expect(textOf(page)).toContain(fr.instructed.confirmedAt.split('{date}')[0] ?? '');
  });

  test('un refus de confirmation hors console (403) ou sur des étapes changées (409) est expliqué, rien ne change', async () => {
    for (const [status, code] of [
      [403, 'human_confirmation_required'],
      [409, 'sha_mismatch'],
    ] as const) {
      installApi({ [`POST /api/apis/${SLUG}/instructed-steps/confirm`]: () => json(status, { error: { code, message: 'x' } }) });
      const mode = inScope(() => useInstructedMode(SLUG, apiDetail({ slug: SLUG, status: 'erreur', instructed: instructed() })));
      expect(await mode.confirm()).toBeNull();
      expect(mode.error.value?.code).toBe(code);
      expect(mode.enabled.value).toBe(false);
      const panel = textOf(await renderHtml(InstructedStepsPanel, { instructed: instructed(), enabled: false, pending: null, error: mode.error.value }));
      expect(panel).toContain(fr.apiErrors[code]);
    }
  });

  test('une intention d’étape contenant du HTML est rendue en texte, sans élément HTML', async () => {
    const hostile = instructed({ steps: [{ id: 's1', intent: XSS, post: [{ kind: 'text_present', value: XSS }] }] });
    for (const locale of ['fr', 'en'] as const) {
      const html = await renderHtml(InstructedStepsPanel, { instructed: hostile, enabled: false, pending: null, error: null }, locale);
      expect(html).not.toMatch(/<img\b/i);
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(textOf(html)).toContain(XSS);
    }
    // Même chose dans la fiche réelle (vue d'ensemble).
    const overview = await renderHtml(ApiOverviewTab, { detail: apiDetail({ slug: SLUG, status: 'erreur', instructed: hostile }), slug: SLUG });
    expect(overview).toContain('data-testid="instructed-panel"');
    expect(overview).not.toMatch(/<img\b/i);
  });

  test('garde-fous : jamais sur une API bloquée ni compilable, jamais dans le panneau « Bloquée », jamais activé par défaut', async () => {
    const offered = (overrides: Partial<Schemas['ApiDetail']>) => instructedOffered(apiDetail({ slug: SLUG, instructed: instructed(), ...overrides }));
    expect(offered({ status: 'erreur' })).toBe(true);
    expect(offered({ status: 'bloquee' })).toBe(false);
    expect(offered({ status: 'erreur', metadata_only: true })).toBe(false);
    expect(offered({ status: 'erreur', instructed: instructed({ compilable: 'yes' }) })).toBe(false);
    expect(offered({ status: 'erreur', instructed: instructed({ compilable: 'unknown' }) })).toBe(false);
    expect(offered({ status: 'erreur', instructed: null })).toBe(false);

    const blocked = apiDetail({
      slug: SLUG,
      status: 'bloquee',
      status_reason: { code: 'blocked_by_protection', params: {} },
      instructed: instructed(),
    });
    for (const tab of ['overview', 'runs', 'strategy'] as const) {
      const html = await renderHtml(ApiDetailPage, { detail: blocked, slug: SLUG, tab, resuming: false });
      expect(html, tab).toContain('data-testid="blocked-panel"');
      expect(html, tab).not.toContain('data-testid="instructed-panel"');
      expect(html, tab).not.toContain('data-testid="reason-action"');
      const texts = controls(html).map((control) => control.text);
      expect(texts, tab).not.toContain(fr.instructed.enable);
      expect(texts, tab).not.toContain(fr.instructed.confirm);
      expect(texts, tab).not.toContain(fr.reasonAction.not_compilable);
    }
    // Rien n'est montré pour une API saine sans étapes instruites.
    const healthy = await renderHtml(ApiDetailPage, { detail: apiDetail({ slug: SLUG }), slug: SLUG, tab: 'overview', resuming: false });
    expect(healthy).not.toContain('data-testid="instructed-panel"');
    expect(healthy).not.toContain('data-testid="instructed-label"');
    expect(healthy).not.toContain('data-testid="instructed-cost-reminder"');
  });

  test('LaunchForm : le rappel du coût par run n’apparaît qu’en mode agent instruit, avant le bouton', async () => {
    const off = await renderHtml(LaunchForm, { schema: {}, estimate: { median_usd: 0.002, sample_size: 10 } });
    expect(off).not.toContain('instructed-cost-reminder');
    const on = await renderHtml(LaunchForm, { schema: {}, estimate: { median_usd: 0.002, sample_size: 10 }, instructedRunUsd: 0.04 }, 'en');
    expect(textOf(on)).toContain(en.launch.instructed.replace('{cost}', usd(0.04, 'en', true)));
    const unknown = await renderHtml(LaunchForm, { schema: {}, estimate: undefined, instructedRunUsd: null });
    expect(textOf(unknown)).toContain(fr.launch.instructedUnknown);
  });
});

describe('codes de raison de la reprise par étape (19b § 3)', () => {
  test('chaque code a sa phrase, son libellé court et son action, en fr et en en, avec les mêmes variables', () => {
    const variables = (message: string): string[] => [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
    for (const code of STEP_REASON_CODES) {
      expect(isStepReasonCode(code)).toBe(true);
      for (const messages of [fr, en]) {
        expect((messages.reasons as Record<string, string>)[code], code).toBeTruthy();
        expect((messages.reasonLabel as Record<string, string>)[code], code).toBeTruthy();
        expect((messages.reasonAction as Record<string, string>)[code], code).toBeTruthy();
      }
      expect(variables((fr.reasons as Record<string, string>)[code] ?? '')).toEqual(variables((en.reasons as Record<string, string>)[code] ?? ''));
    }
    expect(Object.keys(fr.reasonAction).sort()).toEqual([...STEP_REASON_CODES].sort());
    expect(Object.keys(en.reasonAction).sort()).toEqual([...STEP_REASON_CODES].sort());
    // Textes de 19b § 3 (variables à la convention de la console : {a}, {n}).
    expect(fr.reasons.repair_not_validated).toBe('Réparation conforme mais non validée sans agent ; v{a} gardée.');
    expect(fr.reasons.step_cascade).toBe('{n} étapes cassées : une nouvelle enquête est nécessaire.');
    expect(fr.reasonAction).toEqual({
      repair_not_validated: 'Voir la reprise',
      write_step_broken: 'Ouvrir le brouillon',
      step_cascade: 'Ré-enquêter',
      not_compilable: 'Voir le mode agent instruit',
      session_step_broken: 'Ouvrir le brouillon',
    });
  });

  test('parité fr/en des espaces « repairs », « instructed » et des nouvelles erreurs', () => {
    type Tree = { [key: string]: string | Tree };
    const flatten = (tree: Tree, prefix = ''): string[] => Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [`${prefix}${key}`] : flatten(value, `${prefix}${key}.`)));
    for (const space of ['repairs', 'instructed'] as const) expect(flatten(fr[space] as Tree).sort()).toEqual(flatten(en[space] as Tree).sort());
    // Une étiquette par issue et par niveau de l'OpenAPI (StepOutcome, step_level), dans les deux langues.
    const outcomes: Schemas['StepOutcome'][] = ['replayed', 'alternate', 'agent_repaired', 'failed'];
    for (const messages of [fr, en]) {
      expect(Object.keys(messages.repairs.outcome).sort()).toEqual([...outcomes].sort());
      expect(Object.keys(messages.repairs.level)).toEqual(['1', '2', '3']);
    }
    for (const code of ['human_confirmation_required', 'sha_mismatch', 'instructed_steps_unconfirmed', 'compilable', 'no_instructed_steps']) {
      expect((fr.apiErrors as Record<string, string>)[code], code).toBeTruthy();
      expect((en.apiErrors as Record<string, string>)[code], code).toBeTruthy();
    }
  });

  test('la raison montre son action ; « Voir le mode agent instruit » mène à la section, sans rien activer', async () => {
    const html = await renderHtml(ApiDetailPage, { detail: apiDetail({ slug: SLUG, status: 'erreur', status_reason: { code: 'not_compilable', params: {} }, instructed: instructed() }), slug: SLUG, tab: 'runs', resuming: false });
    expect(textOf(html)).toContain(fr.reasons.not_compilable);
    const link = controls(html).find((control) => control.text === fr.reasonAction.not_compilable);
    expect(link?.tag).toBe('a');
    expect(link?.attrs).toContain(`href="/apis/${SLUG}/overview#instructed"`);
    expect(STEP_REASON_ACTIONS.step_cascade).toBe('reinvestigate');
    const cascade = await renderHtml(ApiDetailPage, { detail: apiDetail({ slug: SLUG, status: 'erreur', status_reason: { code: 'step_cascade', params: { n: 3 } } }), slug: SLUG, tab: 'overview', resuming: false });
    expect(textOf(cascade)).toContain('3 étapes cassées : une nouvelle enquête est nécessaire.');
  });
});
