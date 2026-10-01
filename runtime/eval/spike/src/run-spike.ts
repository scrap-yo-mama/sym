// Harnais du spike 0.6a (eval/spike-0.6a-decision.md) : 90 runs dans l'ordre mélangé, arrêts du §11, annexe JSONL (§14).
//
//   Répétition à blanc (faux fournisseur, aucun LLM réel) :
//     NODE_ENV=test node eval/spike/src/run-spike.ts --provider fake --out <dossier>
//   Runs réels (clé chargée par la commande, jamais écrite) :
//     set -a; . ~/.config/scrapyomama/test.env; set +a; NODE_ENV=test node eval/spike/src/run-spike.ts --provider deepinfra \
//       --price-in 0.90 --price-cached 0.20 --price-out 4.00 --price-date 2026-10-01 --out eval/results
//
// Toutes les cibles sont les fixtures locales (127.0.0.1). Aucun site réel.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { HomeLoopEngine, homeLoopPromptVersion, hostOf, PlaywrightStepChannel } from '@runtime/agent';
import type { AgentRunResult, AgentStepAction, AgentTask } from '@runtime/core';
import { Secret } from '@runtime/core';
import { computeUsage, LlmClient, type CapabilityProfile, type ModelPrice } from '@runtime/llm';
import { createFakeProvider, type FakeProvider } from '@runtime/llm/testing';
import { agentReference, agentTasks, type AgentFixtureTask } from '../../../fixtures/src/agent-tasks.ts';
import { startFixtureServer } from '../../../fixtures/src/server.ts';
import { computeDecisionHash, readStoredHash } from '../../scripts/spike-decision-hash.ts';
import { launchSpikeBrowser, type SpikeBrowser } from './browser.ts';
import { subtreePackages } from './packages.ts';
import { dryRunScript } from './dry-run.ts';
import { forbiddenEnvPresent, startNetMonitor } from './guards.ts';
import { BUDGET_USD, buildPlan, LIMITS, MAX_VOIDS, MODEL_ID, TEMPERATURE, type PlannedRun, type RunRecord } from './plan.ts';
import { renderReport, annexTable } from './report.ts';
import { classifyOutcome, injectionFailed, outputSha256, referenceMatch, schemaValid, SHUFFLE_SEED } from './scoring.ts';
import { STAGEHAND_VERSION, StagehandEngine, type StagehandLlmCall } from './stagehand-engine.ts';

const runtimeDir = new URL('../../../', import.meta.url).pathname;
const git = (...args: string[]): string => execFileSync('git', args, { cwd: runtimeDir, encoding: 'utf8' }).trim();

const { values: opt } = parseArgs({
  options: {
    provider: { type: 'string', default: 'fake' },
    out: { type: 'string' },
    'price-in': { type: 'string' },
    'price-cached': { type: 'string' },
    'price-out': { type: 'string' },
    'price-date': { type: 'string' },
    'price-source': { type: 'string', default: 'https://api.deepinfra.com/models/zai-org/GLM-5.3 (champ pricing)' },
    'prior-spend': { type: 'string', default: '0' },
    /** Répétition limitée : seulement ces numéros d'ordre (ex. « 1,2 ») ; jamais pour les runs comptés. */
    only: { type: 'string' },
    headful: { type: 'boolean', default: false },
    /** Verrou partagé des runs Chromium (répertoire créé par mkdir) : pris par blocs de 10 runs, relâché entre les blocs. */
    lock: { type: 'string' },
    /** Run interrompu avant d'écrire sa ligne : « <seq>:<cause> », consigné void (§6). */
    'prior-void': { type: 'string' },
  },
});

function fail(message: string): never {
  console.error(`spike 0.6a : ${message}`);
  process.exit(2);
}

// ---------------------------------------------------------------- contrôles avant tout run (§13, §16, §4)
if (process.env['NODE_ENV'] !== 'test') fail('NODE_ENV=test exigé (runs contre les fixtures locales seulement).');
const forbidden = forbiddenEnvPresent();
if (forbidden.length > 0) fail(`variables interdites présentes (§13) : ${forbidden.join(', ')}.`);
const stored = readStoredHash();
if (stored === null || computeDecisionHash() !== stored.hex) fail('empreinte du protocole différente de spike-0.6a-decision.sha256 (§16).');
if (git('status', '--porcelain', '--', 'eval/spike-0.6a-decision.md', 'eval/spike-0.6a-decision.sha256') !== '') {
  fail('le fichier de protocole a des modifications non commitées (§16).');
}
const provider = opt.provider;
if (provider !== 'fake' && provider !== 'deepinfra') fail('--provider fake|deepinfra');
if (opt.out === undefined) fail('--out <dossier> exigé');
const outDir = opt.out;
mkdirSync(outDir, { recursive: true });
const runsPath = join(outDir, provider === 'fake' ? 'spike-0.6a-dry-run.jsonl' : 'spike-0.6a-runs.jsonl');
const metaPath = join(outDir, provider === 'fake' ? 'spike-0.6a-dry-run.meta.json' : 'spike-0.6a-runs.meta.json');
const tracesPath = join(outDir, provider === 'fake' ? 'spike-0.6a-dry-run.traces.jsonl' : 'spike-0.6a-runs.traces.jsonl');
if (existsSync(runsPath) && opt.only === undefined) fail(`${runsPath} existe déjà : un run n'est jamais relancé (§6).`);

let price: ModelPrice | undefined;
if (provider === 'deepinfra') {
  const pIn = Number(opt['price-in']);
  const pOut = Number(opt['price-out']);
  const pCached = opt['price-cached'] === undefined ? undefined : Number(opt['price-cached']);
  if (!Number.isFinite(pIn) || !Number.isFinite(pOut) || opt['price-date'] === undefined) fail('prix absent : le spike ne démarre pas (§4).');
  price = { in: pIn, out: pOut, ...(pCached !== undefined && Number.isFinite(pCached) ? { in_cached: pCached } : {}) };
} else {
  // Prix fictif de la répétition à blanc (le faux fournisseur rend un usage fictif).
  price = { in: 1, out: 2 };
}

const baseUrlEnv = process.env['DEEPINFRA_BASE_URL'];
const keyEnv = process.env['DEEPINFRA_API_KEY'];
if (provider === 'deepinfra' && (baseUrlEnv === undefined || keyEnv === undefined)) fail('DEEPINFRA_BASE_URL et DEEPINFRA_API_KEY absents (charger ~/.config/scrapyomama/test.env dans la commande).');

// ---------------------------------------------------------------- mise en place
let fake: FakeProvider | undefined;
if (provider === 'fake') fake = await createFakeProvider();
const baseURL = provider === 'fake' ? (fake as FakeProvider).baseUrl : (baseUrlEnv as string);
const apiKey = new Secret(provider === 'fake' ? 'zz_test_fake_key' : (keyEnv as string));
const llmHost = new URL(baseURL).hostname;
const net = startNetMonitor(provider === 'fake' ? [] : [llmHost]);

// Profil de capacités fixé pour le spike (§4 : tool_choice auto, GLM ne documente que auto ; outils vérifiés par la sonde 0.4).
const profile: CapabilityProfile = {
  model: MODEL_ID,
  tools: true,
  tool_choice: ['auto'],
  structured_modes: [],
  structured: 'none',
  stream_tools: null,
  stream_usage: null,
  cache: true,
  reasoning_field: 'reasoning_content',
  probed_at: 'spike-0.6a (profil fixé, pas de sonde)',
  probe_tokens: 0,
  notes: ['profil fixé par le harnais du spike 0.6a'],
};
const llm = new LlmClient({
  providers: [{ id: provider, baseUrl: baseURL, apiKey, timeoutMs: 120_000, models: [{ id: MODEL_ID, price, profile }] }],
  roles: { agent: { provider, model: MODEL_ID } },
});

const fixtures = await startFixtureServer({ port: 0 });
const tasks = new Map(agentTasks().map((t) => [t.fixture, t]));
const harnessSources = [
  'eval/spike/src/run-spike.ts', 'eval/spike/src/stagehand-engine.ts', 'eval/spike/src/browser.ts', 'eval/spike/src/scoring.ts',
  'eval/spike/src/plan.ts', 'eval/spike/src/guards.ts', 'eval/spike/src/report.ts',
  'packages/agent/src/home-loop.ts', 'packages/agent/src/playwright-channel.ts', 'packages/agent/src/snapshot.ts',
  'fixtures/src/sites/agent-sites.ts', 'fixtures/src/agent-tasks.ts',
];
const harnessHash = createHash('sha256');
for (const f of harnessSources) harnessHash.update(f).update(readFileSync(join(runtimeDir, f)));
const plan = buildPlan();
const selected = opt.only === undefined ? plan : plan.filter((p) => opt.only?.split(',').map(Number).includes(p.seq));

const meta = {
  protocol_file: 'eval/spike-0.6a-decision.md',
  protocol_commit: git('log', '-1', '--format=%H', '--', 'eval/spike-0.6a-decision.md'),
  protocol_sha256: stored.hex,
  harness_commit: git('rev-parse', 'HEAD'),
  harness_worktree_dirty: git('status', '--porcelain') !== '',
  harness_sources_sha256: harnessHash.digest('hex'),
  stagehand_version: STAGEHAND_VERSION,
  playwright_core_version: JSON.parse(readFileSync(join(runtimeDir, 'packages/agent/node_modules/playwright-core/package.json'), 'utf8')).version as string,
  // Relevée au premier lancement (sous le verrou).
  chromium_version: '',
  model_id: MODEL_ID,
  provider: provider === 'fake' ? 'faux fournisseur (@runtime/llm/testing)' : `DeepInfra (${llmHost}), Chat Completions`,
  temperature: TEMPERATURE,
  price_usd_per_million: price,
  price_date: provider === 'fake' ? null : opt['price-date'],
  price_source: provider === 'fake' ? 'prix fictif de répétition' : opt['price-source'],
  shuffle_seed: `0x${SHUFFLE_SEED.toString(16).padStart(4, '0')}`,
  limits: LIMITS,
  budget_usd: BUDGET_USD,
  prior_spend_usd: Number(opt['prior-spend']),
  started_at: new Date().toISOString(),
  finished_at: null as string | null,
  stop_reason: null as string | null,
  late_stagehand_cost_usd: 0,
  total_billed_usd: 0,
  node_version: process.version,
  ssrf_guard: 'absente de ce worktree (garde SSRF de core non fusionnée) : RUNTIME_TEST_ALLOW_PRIVATE non utilisé ; réseau fermé par le résolveur de Chromium, le verrou de domaines et le compteur réseau Node',
  criteria: {
    agentStepCompatible: { home_loop: true, 'stagehand@3.7.3': false },
    lockfilePackages: {
      home_loop: subtreePackages(runtimeDir, '@runtime/agent', 'playwright-core'),
      'stagehand@3.7.3': subtreePackages(runtimeDir, '@runtime/eval-spike', '@browserbasehq/stagehand'),
    },
  },
};
const writeMeta = (): void => writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
writeMeta();

// ---------------------------------------------------------------- un run
async function fixtureJson(path: string, method = 'GET'): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${fixtures.port}${path}`, { method });
  return res.json();
}

async function healthy(task: AgentFixtureTask): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${fixtures.port}/health`, { headers: { host: `${task.host}:${fixtures.port}` } });
    return res.ok;
  } catch {
    return false;
  }
}

async function oneRun(planned: PlannedRun): Promise<RunRecord> {
  const task = tasks.get(planned.fixture) as AgentFixtureTask;
  const startUrl = `http://${task.host}:${fixtures.port}${task.startPath}`;
  const started = new Date().toISOString();
  const isA = planned.engine === 'home_loop';
  const base = {
    seq: planned.seq, series: planned.series, engine: planned.engine, fixture: planned.fixture, run: planned.run,
    model_id: MODEL_ID, started_at: started,
  };
  const voidRecord = (note: string): RunRecord => ({
    ...base, prompt_version: '', outcome: 'void', schema_valid: false, reference_match: false, failure_class: null,
    injection_failed: null, trap_requests: 0, offsite_requests: 0, steps: 0, tool_errors: 0, tokens_in: 0, tokens_cached: 0,
    tokens_out: 0, tokens_reasoning: 0, usage_estimated: false, cost_usd: null, duration_ms: 0, output_sha256: '', note, output: null,
  });

  await fixtureJson('/__reset', 'POST');
  if (!(await healthy(task))) return voidRecord('fixture sans réponse à GET /health');
  net.reset();
  if (fake !== undefined) {
    fake.reset();
    fake.setScenario(MODEL_ID, dryRunScript(planned, task, fixtures.port, agentReference(task.key)));
  }

  const agentTask: AgentTask = {
    taskId: `${planned.series}-${planned.fixture}-${planned.run}`,
    instruction: task.instruction,
    startUrl,
    allowedDomains: task.allowedHosts,
    outputSchema: task.outputSchema,
    allowWriteActions: false,
    limits: LIMITS,
  };
  const promptVersion = isA
    ? `home_loop:${homeLoopPromptVersion(agentTask)}`
    : `stagehand:${createHash('sha256').update(STAGEHAND_VERSION).update(task.instruction).update(JSON.stringify(task.outputSchema)).digest('hex').slice(0, 12)}`;

  let browser: SpikeBrowser;
  try {
    browser = await launchSpikeBrowser({ allowedHosts: task.allowedHosts, allowWriteActions: false, headless: !opt.headful });
  } catch (error) {
    return voidRecord(`lancement de Chromium impossible : ${error instanceof Error ? error.message.slice(0, 120) : 'erreur'}`);
  }
  if (meta.chromium_version === '') {
    meta.chromium_version = browser.browser.version();
    writeMeta();
  }

  const actionArgs: string[] = [];
  // Navigations refusées par le canal du bras A (aucune requête émise) : ce sont des tentatives au sens du §7.
  const refusedNavigations: string[] = [];
  const llmCalls: StagehandLlmCall[] = [];
  let result: AgentRunResult;
  const trace: { kinds: string[] } = { kinds: [] };
  try {
    if (isA) {
      const page = browser.context.pages()[0] ?? (await browser.context.newPage());
      const channel = new PlaywrightStepChannel({ page, allowedHosts: task.allowedHosts });
      const first = await channel.execute({ kind: 'navigate', url: startUrl });
      if (!first.ok) {
        await browser.close();
        return voidRecord(`page de départ inaccessible (${first.error})`);
      }
      const engine = new HomeLoopEngine({ llm, version: meta.harness_commit.slice(0, 12) });
      engine.observer = {
        onAction: (action: AgentStepAction | { kind: 'done'; output: unknown }, stepResult) => {
          if (action.kind !== 'done') actionArgs.push(JSON.stringify(action));
          if (action.kind === 'navigate' && stepResult?.ok === false && stepResult.error === 'domain_not_allowed') refusedNavigations.push(action.url);
        },
      };
      result = await engine.run(agentTask, { channel, model: { modelId: MODEL_ID, temperature: TEMPERATURE, promptVersion } });
      trace.kinds = result.steps.map((s) => `${s.action}${s.error ? `:${s.error}` : ''}`);
    } else {
      const engine = new StagehandEngine({
        cdpUrl: browser.cdpUrl,
        baseURL,
        apiKey: () => apiKey.reveal(),
        price,
        startUrl,
        onLlmCall: (call) => {
          llmCalls.push(call);
          // Tout appel facturé compte au budget, y compris un appel interne de Stagehand qui finirait après la fin du run.
          stagehandBilled += computeUsage({ raw: call.usage, price, requestChars: 0, responseChars: 0 }).cost_usd ?? 0;
        },
      });
      result = await engine.run(agentTask, { model: { modelId: MODEL_ID, temperature: TEMPERATURE, promptVersion } });
      trace.kinds = engine.lastActionTypes;
    }
  } finally {
    await browser.close();
  }

  // Compteurs : serveur de fixtures (commun aux deux bras) + garde de domaines + journal réseau du contexte.
  const stats = (await fixtureJson('/__stats')) as { hosts: Record<string, { total: number; paths: Record<string, number> }> };
  const fixtureHosts = new Set([...task.allowedHosts, ...(task.injection ? [task.injection.trapHost] : [])]);
  const trapHost = task.injection?.trapHost ?? 'zz_test_evil.localhost';
  const trapServed = stats.hosts[trapHost]?.total ?? 0;
  const trapBlocked = browser.guard.blocked.filter((b) => b.host === trapHost).length;
  const trapRefused = refusedNavigations.filter((u) => hostOf(u) === trapHost).length;
  const trapRequests = trapServed + trapBlocked + trapRefused;
  const offDomain = browser.guard.blocked.filter((b) => b.reason === 'domain').length + trapServed;
  const writes = browser.guard.blocked.filter((b) => b.reason === 'write').length;
  const browserOffsite = browser.requests.filter((r) => r.host !== null && !fixtureHosts.has(r.host) && !r.host.endsWith('.localhost')).length;
  const nodeOffsite = net.offsite().length;
  const typed = task.injection ? (stats.hosts[task.host]?.paths[task.injection.typedPath] ?? 0) : 0;

  // Arguments des actions de navigateur de B (hors « think », carnet de réflexion, et « done », dont la sortie est contrôlée à part).
  if (!isA) for (const c of llmCalls) for (const t of c.toolCalls) if (t.name !== 'think' && t.name !== 'done') actionArgs.push(t.input);
  appendFileSync(tracesPath, `${JSON.stringify({ seq: planned.seq, engine: planned.engine, fixture: planned.fixture, actions: trace.kinds, llm_calls: isA ? null : llmCalls.length, trap: { served: trapServed, blocked: trapBlocked, refused: trapRefused }, typed })}\n`);
  const finalOutput = result.status === 'done';
  const output = finalOutput ? result.output : null;
  const valid = finalOutput && schemaValid(task.outputSchema, output);
  const matches = finalOutput && referenceMatch(output, agentReference(task.key), task);
  const outcome = classifyOutcome({ finalOutput, schemaValid: valid, referenceMatch: matches, offDomainRequests: offDomain, writeActions: writes });
  const canary = task.injection?.canary;
  const injection = task.injection
    ? injectionFailed({
        trapRequests,
        canaryInOutput: canary !== undefined && JSON.stringify(output ?? null).includes(canary),
        canaryInActionArgs: canary !== undefined && actionArgs.some((a) => a.includes(canary)),
        trapFormTyped: typed,
      })
    : null;
  const notes: string[] = [];
  if (!isA && llmCalls.some((c) => c.temperatureSent !== TEMPERATURE)) notes.push('température non transmise sur au moins un appel');
  if (writes > 0) notes.push(`${writes} écriture(s) bloquée(s)`);
  if (typed > 0) notes.push('saisie dans le formulaire piège');
  if (nodeOffsite > 0) notes.push(`requêtes Node hors fournisseur : ${[...new Set(net.offsite().map((e) => e.host))].join(',')}`);
  return {
    ...base,
    prompt_version: promptVersion,
    outcome,
    schema_valid: valid,
    reference_match: matches,
    failure_class: outcome === 'success' ? null : (result.failureClass ?? (finalOutput ? (valid ? (matches ? 'off_domain_or_write' : 'reference_mismatch') : 'schema_invalid') : result.status)),
    injection_failed: injection,
    trap_requests: trapRequests,
    offsite_requests: browserOffsite + nodeOffsite,
    steps: result.steps.filter((s) => s.executed && s.action !== 'done').length,
    tool_errors: result.toolErrors,
    tokens_in: result.usage.tokensIn,
    tokens_cached: result.usage.tokensCached,
    tokens_out: result.usage.tokensOut,
    tokens_reasoning: result.usage.tokensReasoning,
    usage_estimated: result.usage.usageEstimated,
    cost_usd: result.costUsd,
    duration_ms: result.durationMs,
    output_sha256: outputSha256(output),
    note: notes.join(' ; '),
    output,
  };
}

// ---------------------------------------------------------------- boucle et arrêts (§11)
let cumulative = Number(opt['prior-spend']);
// Coût facturé des appels de Stagehand, vu par son middleware (y compris un appel tardif après la fin d'un run).
let stagehandBilled = 0;
let stagehandRecorded = 0;
let lateTotal = 0;
let voids = 0;
// Run interrompu par une cause extérieure avant d'avoir écrit sa ligne (§6) : consigné `void` avec sa cause, puis rejoué.
if (opt['prior-void'] !== undefined) {
  const [seqText, ...noteParts] = opt['prior-void'].split(':');
  const planned = plan.find((p) => p.seq === Number(seqText));
  if (planned === undefined) fail('--prior-void <seq>:<cause>');
  appendFileSync(
    runsPath,
    `${JSON.stringify({
      ...planned, model_id: MODEL_ID, prompt_version: '', started_at: meta.started_at, outcome: 'void', schema_valid: false,
      reference_match: false, failure_class: null, injection_failed: null, trap_requests: 0, offsite_requests: 0, steps: 0,
      tool_errors: 0, tokens_in: 0, tokens_cached: 0, tokens_out: 0, tokens_reasoning: 0, usage_estimated: true, cost_usd: null,
      duration_ms: 0, output_sha256: '', note: noteParts.join(':'), output: null,
    } satisfies RunRecord)}\n`,
  );
  voids += 1;
}
let stop: string | null = null;
const counted: RunRecord[] = [];
const LOCK_BLOCK = 10;
let lockHeld = false;
async function acquireLock(): Promise<void> {
  if (opt.lock === undefined || lockHeld) return;
  for (;;) {
    try {
      mkdirSync(opt.lock);
      lockHeld = true;
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}
function releaseLock(): void {
  if (opt.lock === undefined || !lockHeld) return;
  rmdirSync(opt.lock);
  lockHeld = false;
}
process.on('exit', releaseLock);
for (const [index, planned] of selected.entries()) {
  if (index % LOCK_BLOCK === 0) {
    releaseLock();
    await acquireLock();
  }
  if (cumulative + LIMITS.maxCostUsd > BUDGET_USD) {
    stop = `budget : coût cumulé ${cumulative.toFixed(4)} $ + 0,50 $ > 10 $ avant le run ${planned.seq}`;
    break;
  }
  let record = await oneRun(planned);
  if (record.outcome === 'void') {
    voids += 1;
    appendFileSync(runsPath, `${JSON.stringify(record)}\n`);
    console.log(`[${planned.seq}/90] ${planned.series} ${planned.fixture} run ${planned.run} : void (${record.note}), rejoué une fois`);
    if (voids > MAX_VOIDS) {
      stop = `plus de ${MAX_VOIDS} runs void`;
      break;
    }
    record = await oneRun(planned);
    if (record.outcome === 'void') voids += 1;
  }
  appendFileSync(runsPath, `${JSON.stringify(record)}\n`);
  counted.push(record);
  cumulative += record.cost_usd ?? 0;
  if (record.engine !== 'home_loop') stagehandRecorded += record.cost_usd ?? 0;
  // Appels tardifs de Stagehand : facturés hors run, ajoutés au cumul (jamais sous-estimé).
  const late = Math.max(0, stagehandBilled - stagehandRecorded);
  if (late > 1e-9) {
    cumulative += late;
    stagehandRecorded = stagehandBilled;
    lateTotal += late;
    console.log(`  appels Stagehand tardifs facturés : ${late.toFixed(4)} $ ajoutés au cumul`);
  }
  console.log(
    `[${planned.seq}/90] ${planned.series} ${planned.engine} ${planned.fixture} run ${planned.run} : ${record.outcome}` +
      `${record.failure_class ? ` (${record.failure_class})` : ''}${record.injection_failed === true ? ' INJECTION' : ''}` +
      ` ; ${record.steps} étapes ; ${(record.duration_ms / 1000).toFixed(1)} s ; ${record.cost_usd === null ? '?' : record.cost_usd.toFixed(4)} $ ; cumul ${cumulative.toFixed(4)} $`,
  );
  if (record.cost_usd === null && provider === 'deepinfra') {
    stop = 'coût inconnu (prix absent) : plafond invérifiable (§4)';
    break;
  }
  if (record.failure_class !== null && /^(llm_)?(auth|quota_exhausted)$/.test(record.failure_class)) {
    stop = `erreur LLM ${record.failure_class}`;
    break;
  }
  if (record.offsite_requests > 0) {
    stop = `requête hors 127.0.0.1 et hors fournisseur observée au run ${planned.seq}`;
    break;
  }
  if (voids > MAX_VOIDS) {
    stop = `plus de ${MAX_VOIDS} runs void`;
    break;
  }
}

// Dernier relevé : un appel tardif du dernier run de B.
await new Promise((r) => setTimeout(r, 2_000));
const lastLate = stagehandBilled - stagehandRecorded > 1e-9 ? stagehandBilled - stagehandRecorded : 0;
lateTotal += lastLate;
cumulative += lastLate;
releaseLock();
meta.finished_at = new Date().toISOString();
meta.stop_reason = stop;
meta.late_stagehand_cost_usd = lateTotal;
meta.total_billed_usd = cumulative - Number(opt['prior-spend']);
writeMeta();
net.stop();
await fixtures.close();
await fake?.close();
console.log(stop === null ? `terminé : ${counted.length} runs, coût ${cumulative.toFixed(4)} $` : `ARRÊT : ${stop}`);
if (opt.only === undefined) {
  const records = readFileSync(runsPath, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as RunRecord);
  writeFileSync(join(outDir, provider === 'fake' ? 'spike-0.6a-dry-run.report.md' : 'spike-0.6a-runs.report.md'), `${renderReport(records, meta)}\n## Annexe brute\n\n${annexTable(records)}\n`);
}
