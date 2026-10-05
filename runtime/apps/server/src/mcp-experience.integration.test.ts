// SPDX-License-Identifier: AGPL-3.0-only
// Expérience MCP (tâche 3.10, 05 § 1.2, § 1.3 et § 4.4) sur un serveur réel, une base migrée et le client de test officiel
// (@modelcontextprotocol/client v2, ères 2025 et 2026-07-28) : `instructions` servies, 4 prompts (noms stables, titres
// localisés, corps en anglais, consigne du dossier d'enquête), récit obligatoire dans `content` et `timeline[]` dans
// `structuredContent` (assert_text_only_sufficient, assert_narrative_matches_structured), progression strictement croissante
// (assert_progress_monotonic), élicitation de la validation du schéma avec repli, annulation d'une enquête sous 5 s,
// gabarits fermés des statuts bloquée et action requise (assert_blocked_message_templates). Le worker est simulé en base :
// il écrit les événements `investigation_events` que le vrai worker écrirait, ces tests portent sur le contrat MCP.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { seedApi, seedRun } from '../../../tests/helpers/rest-seed.js';
import { createKey, createUser, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';
import { BRIEF_INSTRUCTION } from './mcp/prompts.js';
import { actionTemplate, blockedTemplate } from './mcp/texts.js';
import { INSTRUCTIONS_MAX_CHARS, INSTRUCTIONS_VITAL_CHARS, MCP_INSTRUCTIONS } from './mcp/tools.js';

type Party = { user: TestUser; cookie: string; key: string };
type ToolResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Era = 'legacy' | 'modern';

const ALL_SCOPES = ['apis:read', 'apis:run', 'apis:write', 'runs:read', 'datasets:read', 'schedules:write', 'sites:read'];
const BYPASS = /contourn|débloqu|bypass|unblock|circumvent|proxy|tunnel|captcha|stealth|indétect|undetect|spoof/i;

let srv: TestServer;
let base: string;
let a: Party;
let b: Party;
/** Compte dont la langue enregistrée est `fr` (21 § 4.3 : la langue du compte, sans ?lang=). */
let frAccount: Party;
const clients: Client[] = [];

type Elicit = { seen: { message: string; requestedSchema: unknown }[]; answer: () => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> } };

/** Client MCP de test. `elicit` : déclare l'élicitation de formulaire et répond par `answer` ; `era` : 2025 (défaut) ou 2026-07-28. */
async function connect(key: string, opts: { era?: Era; lang?: string; elicit?: Elicit } = {}): Promise<Client> {
  const url = new URL(`${base}/mcp${opts.lang === undefined ? '' : `?lang=${opts.lang}`}`);
  const client = new Client(
    { name: 'zz-test-client', version: '1.0.0' },
    {
      ...(opts.elicit === undefined ? {} : { capabilities: { elicitation: { form: {} } } }),
      ...(opts.era === 'modern' ? { versionNegotiation: { mode: 'auto' as const } } : {}),
    },
  );
  const elicit = opts.elicit;
  if (elicit !== undefined) {
    client.setRequestHandler('elicitation/create', async (request) => {
      const params = request.params as { message: string; requestedSchema: unknown };
      elicit.seen.push({ message: params.message, requestedSchema: params.requestedSchema });
      return elicit.answer();
    });
  }
  await client.connect(new StreamableHTTPClientTransport(url, { authProvider: { token: async () => key } }));
  clients.push(client);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>, options?: { onprogress?: (p: { progress: number; message?: string }) => void }): Promise<ToolResult> =>
  (await client.callTool({ name, arguments: args }, options)) as ToolResult;

const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');

const count = async (sql: string, params: unknown[] = []) => withClient(srv.db.url, async (c) => Number(Object.values((await c.query<Record<string, string>>(sql, params)).rows[0]!)[0]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Écrit un événement d'enquête comme le worker (numéro suivant, propriétaire et projet du run). */
async function emit(runId: string, kind: string, payload: Record<string, unknown>): Promise<void> {
  await withClient(srv.db.url, async (c) => {
    await c.query(
      `INSERT INTO investigation_events (run_id, seq, owner_id, project_id, kind, payload)
       SELECT r.id, coalesce((SELECT max(e.seq) FROM investigation_events e WHERE e.run_id = r.id), 0) + 1, r.owner_id, r.project_id, $2, $3::jsonb FROM runs r WHERE r.id = $1`,
      [runId, kind, JSON.stringify({ run_id: runId, ...payload })],
    );
  });
}

/**
 * Premier run d'enquête en file de l'utilisateur (créé par l'appel MCP en cours) : marqué `running` pour n'être pris qu'une fois.
 * `before` : runs déjà en file avant l'appel (laissés par un test précédent sans worker), jamais pris.
 */
async function nextInvestigation(owner: Party, timeoutMs = 10_000, before: readonly string[] = []): Promise<{ runId: string; apiId: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await withClient(srv.db.url, async (c) => {
      const { rows } = await c.query<{ id: string; api_id: string }>(
        "UPDATE runs SET state = 'running', started_at = now() WHERE id = (SELECT id FROM runs WHERE owner_id = $1 AND kind = 'investigation' AND state = 'queued' AND NOT (id = ANY($2::uuid[])) ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id, api_id",
        [owner.user.id, before],
      );
      return rows[0];
    });
    if (row !== undefined) return { runId: row.id, apiId: row.api_id };
    if (Date.now() > deadline) throw new Error('aucune enquête créée');
    await sleep(25);
  }
}

const SCHEMA = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' }, price: { type: 'number' } } };
const BUDGET = (spent: number, elapsed = 0) => ({ spent_usd: spent, max_usd: 0.5, elapsed_s: elapsed, timeout_s: 120 });
const ACCESS_VIEW = { id: '00000000-0000-0000-0000-0000000000a1', checked_at: new Date().toISOString(), signal: 'allowed', usage_signals: [], llms_txt: false, payment_offer: null, official_api_url: null };

/**
 * Worker simulé, première enquête : rapport d'accès, reconnaissance, schéma proposé ; puis l'API attend la validation du
 * schéma et le run se termine (`succeeded`), comme à la fin d'une enquête sans `auto_validate`.
 */
async function simulateFirstInvestigation(owner: Party, gapMs = 120, before: readonly string[] = []): Promise<{ runId: string; apiId: string }> {
  const { runId, apiId } = await nextInvestigation(owner, 10_000, before);
  await emit(runId, 'investigation.started', { phase: 'access_report', url: 'https://zz-books.example/catalogue/', domain: 'zz-books.example', network: 'direct', budget: BUDGET(0) });
  await sleep(gapMs);
  await emit(runId, 'access_report', { id: ACCESS_VIEW.id, view: ACCESS_VIEW, verdict: { proceed: true } });
  await sleep(gapMs);
  await emit(runId, 'phase.started', { phase: 'reconnaissance', budget: BUDGET(0) });
  await sleep(gapMs);
  await emit(runId, 'reconnaissance.finished', { mode: 'browser', candidates: [{ id: 'c1' }, { id: 'c2' }], document_bytes: 100, total_bytes: 200, budget: BUDGET(0.002, 3) });
  await sleep(gapMs);
  await emit(runId, 'schema.proposed', { ok: true, output_schema: SCHEMA, sample: [{ title: 'zz_test A', price: 1 }, { title: 'zz_test B', price: 2 }], sources: ['c1'], rejected: [], budget: BUDGET(0.002, 3) });
  await emit(runId, 'phase.started', { phase: 'awaiting_schema_validation', plan: [], budget: BUDGET(0.002, 3) });
  await withClient(srv.db.url, async (c) => {
    await c.query("UPDATE apis SET investigation_phase = 'awaiting_schema_validation', investigation = investigation || jsonb_build_object('proposed_schema', $2::jsonb) WHERE id = $1", [apiId, JSON.stringify(SCHEMA)]);
    await c.query("UPDATE runs SET state = 'succeeded', outcome = 'clean', finished_at = now(), duration_ms = 3200, cost_llm_usd = 0.002, cost_proxy_usd = 0 WHERE id = $1", [runId]);
  });
  return { runId, apiId };
}

/**
 * Worker simulé, essais après validation : comme le vrai worker, chaque run d'enquête commence par le rapport d'accès
 * (étape 0, imposé par le déclencheur investigation_events_access_report_first de 0015) et refait la reconnaissance (l'état
 * ne garde aucune valeur du site, 17 § 6) ; puis un essai conforme sur 2 pages, stratégie retenue, run terminé.
 */
async function simulateTrials(owner: Party, gapMs = 100): Promise<string> {
  const { runId, apiId } = await nextInvestigation(owner);
  await emit(runId, 'investigation.started', { phase: 'testing', url: 'https://zz-books.example/catalogue/', domain: 'zz-books.example', network: 'direct', budget: BUDGET(0.002) });
  await sleep(gapMs);
  await emit(runId, 'access_report', { id: ACCESS_VIEW.id, view: ACCESS_VIEW, verdict: { proceed: true } });
  await sleep(gapMs);
  await emit(runId, 'reconnaissance.finished', { mode: 'browser', candidates: [{ id: 'c1' }, { id: 'c2' }], document_bytes: 100, total_bytes: 200, budget: BUDGET(0.002) });
  await emit(runId, 'phase.started', { phase: 'testing', plan: [], budget: BUDGET(0.002) });
  await sleep(gapMs);
  await emit(runId, 'attempt.finished', {
    attempt: { execution: 'fetch', network: 'direct', est_cost_usd: 0.0001, result: 'ok', cost_usd: 0.0001, ms: 400 },
    source: 'c1',
    executions: [{ ok: true, records: 20, pages: 2, stop: 'max_pages', cost_usd: 0.0001, ms: 400 }],
    budget: BUDGET(0.0021),
  });
  await sleep(gapMs);
  await emit(runId, 'investigation.finished', { outcome: 'conformant', strategy: { version: 1, execution: 'fetch', network: 'direct', est_cost_usd: 0.0001 }, items: 20, budget: BUDGET(0.0021, 4) });
  await withClient(srv.db.url, async (c) => {
    await c.query("UPDATE apis SET investigation_phase = 'done' WHERE id = $1", [apiId]);
    await c.query("UPDATE runs SET state = 'succeeded', outcome = 'clean', finished_at = now(), duration_ms = 4000, cost_llm_usd = 0.002, cost_proxy_usd = 0.0001 WHERE id = $1", [runId]);
  });
  return runId;
}

/** Enquêtes déjà en file de l'utilisateur (aucun worker) : à exclure de la simulation de l'appel suivant. */
const queuedInvestigations = async (owner: Party): Promise<string[]> =>
  withClient(srv.db.url, async (c) => (await c.query<{ id: string }>("SELECT id FROM runs WHERE owner_id = $1 AND kind = 'investigation' AND state = 'queued'", [owner.user.id])).rows.map((r) => r.id));

/**
 * Worker simulé, enquête arrêtée pour une cause nommée (UX-04 : contact du robot ou prix du modèle absent) : comme
 * `finishStopped` du vrai worker, l'action requise puis la fin `stopped`, sans classe d'échec ; la cause vit dans
 * `error_detail` du run, l'API passe en `action_requise`.
 */
async function stopRun(runId: string, apiId: string, cause: 'instance_contact_missing' | 'llm_price_missing', detail: string, opts: { access?: boolean } = {}): Promise<void> {
  await emit(runId, 'investigation.started', { phase: 'access_report', url: 'https://zz-books.example/catalogue/', domain: 'zz-books.example', network: 'direct', budget: BUDGET(0) });
  if (opts.access === true) {
    await emit(runId, 'access_report', { id: ACCESS_VIEW.id, view: ACCESS_VIEW, verdict: { proceed: true } });
    await emit(runId, 'reconnaissance.finished', { mode: 'browser', candidates: [{ id: 'c1' }], document_bytes: 100, total_bytes: 200, budget: BUDGET(0) });
  }
  await emit(runId, 'action.required', { cause, domain: 'zz-books.example', ...(detail.includes(':') ? { model: detail.split(':')[1] } : {}) });
  await emit(runId, 'investigation.finished', { outcome: 'stopped', stop_reason: cause, detail, budget: BUDGET(0) });
  await withClient(srv.db.url, async (c) => {
    await c.query("UPDATE runs SET state = 'failed', outcome = 'failed', failure_class = NULL, retryable = false, error_detail = $2, started_at = coalesce(started_at, now()), finished_at = now(), duration_ms = 5 WHERE id = $1", [runId, detail]);
    await c.query("UPDATE apis SET status = 'action_requise', status_reason = $2, investigation_phase = 'done' WHERE id = $1", [apiId, cause]);
  });
}

beforeAll(async () => {
  srv = await startTestServer(
    'mcp_exp',
    { MAX_WAIT_SECONDS: '5', MAX_CONCURRENT_RUNS: '1000', MAX_ACTIVE_RUNS_PER_USER: '1000', MAX_RUNS_PER_KEY_PER_MINUTE: '1000', MCP_ALLOWED_HOSTS: '127.0.0.1' },
    { rest: { pollMs: 40 } },
  );
  const owner = await runSetup(srv);
  const party = async (user: TestUser): Promise<Party> => {
    const cookie = await signIn(srv, user);
    return { user, cookie, key: (await createKey(srv, cookie, user, ALL_SCOPES)).key };
  };
  await party(owner);
  a = await party(await createUser(srv, 'zz_test_mcpx_a@example.test'));
  b = await party(await createUser(srv, 'zz_test_mcpx_b@example.test'));
  frAccount = await party(await createUser(srv, 'zz_test_mcpx_fr@example.test'));
  await withClient(srv.db.url, (c) => c.query("UPDATE users SET locale = 'fr' WHERE id = $1", [frAccount.user.id]));
  base = await srv.app.listen({ port: 0, host: '127.0.0.1' });
}, 180_000);

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
  await srv.close();
});

describe('instructions et prompts (05 § 1.3, 19c § 8, 21 § 4.3)', () => {
  test('assert_instructions_length : instructions servies, 1 000 caractères au plus, l’essentiel dans les 512 premiers, consigne du dossier', async () => {
    const instructions = (await connect(a.key)).getInstructions() ?? '';
    expect(instructions).toBe(MCP_INSTRUCTIONS);
    expect(instructions.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
    const vital = instructions.slice(0, INSTRUCTIONS_VITAL_CHARS);
    for (const needle of ['list_apis', 'create_api', 'validate_schema', 'bloquee', 'never retry']) expect(vital, needle).toContain(needle);
    expect(instructions).toContain('Before create_api, put what you found in brief.');
    expect(instructions.endsWith("Reply in the user's language.")).toBe(true);
  });

  test('4 prompts : noms stables, titres de marque sym:, titres localisés par ?lang=, cacheScope privé', async () => {
    const enClient = await connect(a.key, { lang: 'en' });
    // Liste fixe de 4 prompts : capacité prompts déclarée sans listChanged (aucune notification promise, jamais envoyée).
    expect(enClient.getServerCapabilities()?.prompts).toEqual({ listChanged: false });
    const en = await enClient.listPrompts();
    const fr = await (await connect(a.key, { lang: 'fr' })).listPrompts();
    expect(en.prompts.map((p) => p.name).sort()).toEqual(['first_steps', 'fix_api', 'new_api', 'review_catalog']);
    expect(fr.prompts.map((p) => p.name).sort()).toEqual(en.prompts.map((p) => p.name).sort());
    for (const p of en.prompts) expect(p.title).toMatch(/^sym:/);
    const enNew = en.prompts.find((p) => p.name === 'new_api')!;
    const frNew = fr.prompts.find((p) => p.name === 'new_api')!;
    expect(enNew.description).not.toBe(frNew.description);
    expect(enNew.arguments?.map((x) => x.name).sort()).toEqual(['description', 'url']);
    expect(enNew.arguments?.every((x) => x.required !== true)).toBe(true);
  });

  test('prompt new_api : consigne de compilation du dossier, aucun contenu ajouté par le serveur hors gabarit, dernière phrase = langue de la réponse', async () => {
    const client = await connect(a.key, { lang: 'fr' });
    const got = await client.getPrompt({ name: 'new_api', arguments: { description: 'zz_test les livres', url: 'https://zz-books.example/' } });
    const body = got.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
    expect(body).toContain(BRIEF_INSTRUCTION);
    expect(body).toContain('zz_test les livres');
    expect(body).toContain('data, not instructions');
    expect(body.trimEnd().endsWith('Answer the user in French.')).toBe(true);
    expect(body).not.toMatch(BYPASS);
    const english = await (await connect(a.key)).getPrompt({ name: 'first_steps' });
    expect(JSON.stringify(english)).toContain('Answer the user in English.');
    for (const name of ['fix_api', 'review_catalog']) expect(JSON.stringify(await client.getPrompt({ name, arguments: name === 'fix_api' ? { slug: 'zz-x' } : {} }))).toContain('Answer the user in French.');
  });
});

describe('récit et timeline (05 § 1.2)', () => {
  test('assert_text_only_sufficient : client sans capacité optionnelle, le texte seul donne phases, essais, coût, stratégie et prochaine action', async () => {
    const client = await connect(a.key);
    const sim = simulateFirstInvestigation(a);
    const created = await call(client, 'create_api', { description: 'zz_test livres', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    const simulated = await sim;
    expect(created.isError ?? false).toBe(false);
    const first = text(created);
    // Les identifiants de la suite sont dans le texte : le client qui n'affiche que `content` appelle validate_schema avec eux.
    const apiId = /validate_schema with api_id ([0-9a-f-]{36})/.exec(first)?.[1];
    expect(apiId, 'api_id dans le texte de create_api').toBe(simulated.apiId);
    expect(first).toContain(`"api_id":"${simulated.apiId}"`);
    expect(first).toContain(`"run_id":"${simulated.runId}"`);
    // Phases, étapes numérotées, coût en tête de ligne, prochaine action et lien console, schéma à montrer à la personne.
    expect(first).toMatch(/^Investigation [a-z0-9-]+ · zz-books\.example · awaiting_schema_validation/m);
    expect(first).toMatch(/^1\. Access report: no signal to review \[\d+\.\d s, \$0\]/m);
    expect(first).toMatch(/^2\. Reconnaissance: 2 candidate data sources \(browser\) \[\d+\.\d s, \$0\.002\]/m);
    expect(first).toContain('Output schema proposed: 2 fields');
    expect(first).toMatch(/Cost: \$0\.002/);
    expect(first).toContain('Next step: show the proposed schema to the user, then call validate_schema');
    expect(first).toMatch(/Console: http\S+\/apis\/[a-z0-9-]+$/m);
    expect(first).toContain('Proposed output schema: {"type":"object"');
    expect(first).toContain('zz_test A');

    // Deuxième temps : validate_schema, essais, stratégie ; le texte dit l'essai, son coût et la suite, sans structuredContent.
    const trials = simulateTrials(a);
    const validated = await call(client, 'validate_schema', { api_id: apiId, wait_seconds: 5 });
    await trials;
    const second = text(validated);
    expect(second).toMatch(/^Investigation .* · done/m);
    expect(second).toMatch(/^1\. Access report: no signal to review \[\d+\.\d s, \$0\]/m);
    expect(second).toMatch(/^2\. Reconnaissance: 2 candidate data sources \(browser\) \[\d+\.\d s, \$0\]/m);
    expect(second).toMatch(/^3\. Trial fetch\/direct: conformant, 20 items, 2 pages \[0\.4 s, \$0\.0001\]/m);
    expect(second).toContain('Strategy kept: fetch/direct (E1, $0.0001 per run)');
    expect(second).toMatch(/Cost: \$0\.0021/);
    expect(second).toMatch(/Next step: call api_\w+ with its input, or run_api\./);
    expect(second).toContain('If the tool does not appear, reconnect the server.');
  });

  test('assert_narrative_matches_structured : le texte et structuredContent citent les mêmes essais, coûts et durées', async () => {
    const client = await connect(a.key);
    const sim = simulateFirstInvestigation(a, 60);
    const created = await call(client, 'create_api', { description: 'zz_test livres bis', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    const { apiId } = await sim;
    const trials = simulateTrials(a, 60);
    const validated = await call(client, 'validate_schema', { api_id: apiId, wait_seconds: 5 });
    await trials;
    for (const result of [created, validated]) {
      const structured = result.structuredContent as { timeline: { kind: string; step: number | null; cost_usd?: number; ms?: number | null; execution?: string; network?: string; result?: string; records?: number | null; pages?: number | null }[]; attempts: { index: number; execution: string; network: string; result: string; records: number | null; pages: number | null; cost_usd: number; ms: number | null }[]; cost: { total_usd: number | null }; console_url: string };
      const body = text(result);
      // Chaque étape numérotée de la chronologie a sa ligne, dans l'ordre, avec la même durée et le même coût.
      const stepped = structured.timeline.filter((e) => e.step !== null && e.step > 0);
      expect(stepped.length).toBeGreaterThan(0);
      const lines = [...body.matchAll(/^(\d+)\. (.*?) \[(\d+\.\d) s, \$([\d.]+|<0\.0001)\]$/gm)];
      expect(lines.map((l) => Number(l[1]))).toEqual(stepped.map((e) => e.step));
      stepped.forEach((entry, i) => {
        expect(Number(lines[i]![3]), `durée de l'étape ${entry.step}`).toBeCloseTo((entry.ms ?? 0) / 1000, 1);
        expect(Number(String(lines[i]![4]).replace('<', '')), `coût de l'étape ${entry.step}`).toBeCloseTo(entry.cost_usd ?? 0, 4);
      });
      // Essais : mêmes exécution/réseau, résultat, items et pages que le texte.
      for (const attempt of structured.attempts) {
        const line = lines.find((l) => Number(l[1]) === attempt.index)![2]!;
        expect(line).toContain(`Trial ${attempt.execution}/${attempt.network}: ${attempt.result === 'ok' ? 'conformant' : attempt.result}`);
        if (attempt.records !== null) expect(line).toContain(`${attempt.records} items`);
        if (attempt.pages !== null) expect(line).toContain(`${attempt.pages} pages`);
      }
      // Coût total et lien de la console : identiques.
      expect(body).toContain(`Cost: $${Number(structured.cost.total_usd!.toFixed(4))}`);
      expect(body).toContain(structured.console_url);
    }
    expect((validated.structuredContent as { attempts: unknown[] }).attempts).toHaveLength(1);
    expect((created.structuredContent as { attempts: unknown[] }).attempts).toHaveLength(0);
  });

  test('récit localisé : ?lang=fr rend le récit en français, structuredContent inchangé (codes) et message_locale', async () => {
    const client = await connect(a.key, { lang: 'fr' });
    const sim = simulateFirstInvestigation(a, 40);
    const created = await call(client, 'create_api', { description: 'zz_test livres fr', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    await sim;
    const body = text(created);
    expect(body).toMatch(/^Enquête /m);
    expect(body).toMatch(/^1\. Rapport d’accès : aucun signal à examiner \[\d+,\d s, 0 \$\]/m);
    expect(body).toContain('Prochaine étape : montre le schéma proposé');
    expect(created.structuredContent).toMatchObject({ message_locale: 'fr', investigation_phase: 'awaiting_schema_validation' });
  });

  test('langue du compte sans ?lang= (21 § 4.3) : compte en fr, récit et titres de prompts en français ; ?lang=en la remplace', async () => {
    const own = await connect(frAccount.key);
    const asked = await (await connect(a.key, { lang: 'fr' })).listPrompts();
    const english = await (await connect(a.key, { lang: 'en' })).listPrompts();
    const prompts = await own.listPrompts();
    const byName = (list: typeof prompts) => Object.fromEntries(list.prompts.map((p) => [p.name, { title: p.title, description: p.description }]));
    expect(byName(prompts)).toEqual(byName(asked));
    expect(byName(prompts)).not.toEqual(byName(english));
    const sim = simulateFirstInvestigation(frAccount, 40);
    const created = await call(own, 'create_api', { description: 'zz_test livres du compte fr', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    await sim;
    const body = text(created);
    expect(body).toMatch(/^Enquête /m);
    expect(body).toMatch(/^1\. Rapport d’accès : /m);
    expect(body).toContain('Prochaine étape : montre le schéma proposé');
    expect(created.structuredContent).toMatchObject({ message_locale: 'fr' });
    // ?lang= remplace la langue du compte.
    const overridden = await (await connect(frAccount.key, { lang: 'en' })).listPrompts();
    expect(byName(overridden)).toEqual(byName(english));
  });

  test('get_run d’une enquête : le même récit (timeline non vide) ; run ordinaire : phrase et JSON, timeline vide', async () => {
    const client = await connect(a.key);
    const sim = simulateFirstInvestigation(a, 30);
    const created = await call(client, 'create_api', { description: 'zz_test livres get_run', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    const { runId } = await sim;
    const got = await call(client, 'get_run', { run_id: runId });
    expect((got.structuredContent as { timeline: unknown[] }).timeline.length).toBeGreaterThan(3);
    expect(text(got)).toMatch(/^1\. Access report:/m);
    expect((created.structuredContent as { run_id: string }).run_id).toBe(runId);
    const api = await seedApi(srv.db.url, a.user.id);
    const { runId: plain } = await seedRun(srv.db.url, { apiId: api.id, ownerId: a.user.id, items: [{ title: 'zz_test p' }] });
    const run = await call(client, 'get_run', { run_id: plain });
    expect((run.structuredContent as { timeline: unknown[] }).timeline).toEqual([]);
    expect(text(run)).toContain('The run succeeded');
  });

  test.todo('assert_text_only_sufficient (récit du dossier, MCP) : create_api avec un dossier valide rend l’accusé « SYM 👻 : J’ai lu ton dossier… » et un état par indice dans le texte seul, sans recopier le dossier — le service de 2.14 n’est pas fusionné (D-83 : un dossier valide répond brief_unavailable) ; le rendu du récit du dossier est déjà prêt et joué au niveau du générateur (mcp/experience.unit.test.ts) ; 2.14 le joue ici, puis en 4.2');

  test('B ne lit ni l’enquête ni le récit de A (INV12) : get_run répond comme pour un objet inexistant', async () => {
    const client = await connect(a.key);
    const sim = simulateFirstInvestigation(a, 20);
    await call(client, 'create_api', { description: 'zz_test livres privé', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    const { runId } = await sim;
    const other = await call(await connect(b.key), 'get_run', { run_id: runId });
    expect(other.isError).toBe(true);
    expect(text(other)).not.toContain('zz-books');
  });
});

describe('progression (05 § 1.2) : notifications/progress facultatif, strictement croissant', () => {
  for (const era of ['legacy', 'modern'] as const) {
    test(`assert_progress_monotonic (ère ${era}) : la progression suit les événements de l’enquête, strictement croissante, avec un message`, async () => {
      const client = await connect(a.key, { era });
      const seen: { progress: number; message?: string }[] = [];
      const sim = simulateFirstInvestigation(a, 150);
      const created = await call(client, 'create_api', { description: `zz_test livres progress ${era}`, url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 }, { onprogress: (p) => seen.push(p) });
      await sim;
      expect(created.isError ?? false).toBe(false);
      expect(seen.length, JSON.stringify(seen)).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < seen.length; i += 1) expect(seen[i]!.progress, `progress ${i}`).toBeGreaterThan(seen[i - 1]!.progress);
      expect(seen.every((p) => typeof p.message === 'string' && p.message.length > 0)).toBe(true);
      expect(seen.some((p) => /Access report/.test(p.message ?? ''))).toBe(true);
    });
  }

  test('sans jeton de progression, aucune notification n’est envoyée et le résultat est le même', async () => {
    const client = await connect(a.key, { era: 'modern' });
    const sim = simulateFirstInvestigation(a, 40);
    const created = await call(client, 'create_api', { description: 'zz_test livres sans progress', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    await sim;
    expect(text(created)).toMatch(/^1\. Access report:/m);
  });
});

describe('élicitation de la validation du schéma (05 § 1.3) : question plate, repli sur validate_schema', () => {
  const elicitBy = (answer: Elicit['answer']): Elicit => ({ seen: [], answer });

  test('client 2026-07-28 qui accepte : une question plate (schéma en texte, décision à valeurs stables, remarque), puis validate_schema joué', async () => {
    const elicit = elicitBy(() => ({ action: 'accept', content: { decision: 'validate' } }));
    const client = await connect(a.key, { era: 'modern', elicit });
    const sim = simulateFirstInvestigation(a, 40);
    const before = await count("SELECT count(*) FROM runs WHERE owner_id = $1 AND kind = 'investigation'", [a.user.id]);
    const result = call(client, 'create_api', { description: 'zz_test livres élicitation oui', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    const { apiId } = await sim;
    // Après l'acceptation, le client rejoue l'appel : validate_schema crée l'enquête d'essais ; le worker simulé la termine.
    const trials = simulateTrials(a, 40);
    const final = await result;
    await trials;
    expect(elicit.seen).toHaveLength(1);
    const asked = elicit.seen[0]!;
    expect(asked.message).toContain('Validate this output schema?');
    expect(asked.message).toContain('"price"');
    const props = (asked.requestedSchema as { properties: Record<string, { enum?: string[]; enumNames?: string[] }>; required: string[] }).properties;
    expect(props['decision']!.enum).toEqual(['validate', 'modify']);
    expect(props['decision']!.enumNames).toEqual(['Yes, validate', 'Modify (add a remark)']);
    expect(Object.keys(props).sort()).toEqual(['decision', 'remark']);
    expect(final.isError ?? false).toBe(false);
    expect(text(final)).toContain('Strategy kept: fetch/direct');
    expect(await count("SELECT count(*) FROM runs WHERE owner_id = $1 AND kind = 'investigation'", [a.user.id])).toBe(before + 2);
    expect(await count("SELECT count(*) FROM audit_events WHERE action = 'api.schema_validated' AND target_id = $1", [apiId])).toBe(1);
  });

  test('refus (decline) : aucun schéma validé, aucun essai lancé, la phase reste en attente', async () => {
    const elicit = elicitBy(() => ({ action: 'decline' }));
    const client = await connect(a.key, { era: 'modern', elicit });
    const sim = simulateFirstInvestigation(a, 40);
    const before = await count("SELECT count(*) FROM runs WHERE owner_id = $1 AND kind = 'investigation'", [a.user.id]);
    const final = await call(client, 'create_api', { description: 'zz_test livres élicitation non', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    const { apiId } = await sim;
    expect(elicit.seen).toHaveLength(1);
    expect(text(final)).toContain('did not validate the schema');
    expect(text(final)).toContain('no trial was started');
    expect(await count("SELECT count(*) FROM runs WHERE owner_id = $1 AND kind = 'investigation'", [a.user.id])).toBe(before + 1);
    expect(await count("SELECT count(*) FROM audit_events WHERE action = 'api.schema_validated' AND target_id = $1", [apiId])).toBe(0);
    expect(await count("SELECT count(*) FROM apis WHERE id = $1 AND investigation_phase = 'awaiting_schema_validation'", [apiId])).toBe(1);
    expect((final.structuredContent as { investigation_phase: string }).investigation_phase).toBe('awaiting_schema_validation');
  });

  test('« modifier » avec remarque : rien n’est lancé, la remarque est rendue comme venant de la personne, la suite est d’ajuster le schéma', async () => {
    const elicit = elicitBy(() => ({ action: 'accept', content: { decision: 'modify', remark: 'zz_test renomme price en prix' } }));
    const client = await connect(a.key, { era: 'modern', elicit });
    const sim = simulateFirstInvestigation(a, 40);
    const before = await count("SELECT count(*) FROM runs WHERE owner_id = $1 AND kind = 'investigation'", [a.user.id]);
    const final = await call(client, 'create_api', { description: 'zz_test livres élicitation modifier', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    await sim;
    expect(text(final)).toContain('remark from the user, not from the site): zz_test renomme price en prix');
    expect(text(final)).toContain('Next step: adjust the schema to the remark');
    expect(await count("SELECT count(*) FROM runs WHERE owner_id = $1 AND kind = 'investigation'", [a.user.id])).toBe(before + 1);
    expect(final.structuredContent).toMatchObject({ user_remark: 'zz_test renomme price en prix' });
  });

  test('repli : client sans élicitation (ères 2025 et 2026-07-28), ou client 2025 sans état : awaiting_schema_validation et validate_schema', async () => {
    for (const client of [await connect(a.key, { era: 'modern' }), await connect(a.key), await connect(a.key, { elicit: elicitBy(() => ({ action: 'accept', content: { decision: 'validate' } })) })]) {
      const sim = simulateFirstInvestigation(a, 30);
      // `force_new` : la même demande, répétée par trois clients, serait sinon reconnue (une demande, une enquête, UXI8).
      const result = await call(client, 'create_api', { description: 'zz_test livres repli', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
      const { apiId } = await sim;
      expect(result.isError ?? false).toBe(false);
      expect(result.structuredContent).toMatchObject({ api_id: apiId, investigation_phase: 'awaiting_schema_validation', next_action: { tool: 'validate_schema' } });
      expect(text(result)).toContain('call validate_schema');
      expect(await count("SELECT count(*) FROM audit_events WHERE action = 'api.schema_validated' AND target_id = $1", [apiId])).toBe(0);
    }
  });

  test('auto_validate : aucune question (la validation est demandée par l’appelant)', async () => {
    const elicit = elicitBy(() => ({ action: 'decline' }));
    const client = await connect(a.key, { era: 'modern', elicit });
    // Sans la case « j'ai lu » (17 § 11), auto_validate est refusé par la route REST : une erreur, jamais une question.
    const refused = await call(client, 'create_api', { description: 'zz_test livres auto', url: 'https://zz-books.example/catalogue/', auto_validate: true, force_new: true, wait_seconds: 0 });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('responsible_use_ack_required');
    await withClient(srv.db.url, (c) => c.query("INSERT INTO responsible_use_acks (user_id, version) VALUES ($1, '2026-10-01') ON CONFLICT DO NOTHING", [a.user.id]));
    // L'enquête ne se termine pas pendant l'attente (aucun worker) : le résultat est « running », jamais une question.
    const result = await call(client, 'create_api', { description: 'zz_test livres auto', url: 'https://zz-books.example/catalogue/', auto_validate: true, force_new: true, wait_seconds: 0 });
    expect(elicit.seen).toHaveLength(0);
    expect(result.isError ?? false).toBe(false);
  });
});

describe('UX-04 / UX-07 : le récit porte la cause nommée d’un run arrêté (envelope.error)', () => {
  test('get_run d’une enquête arrêtée (contact du robot absent, failure_class NULL) : la phrase d’UX-04, le gabarit fermé de la cause et la marche à suivre dans le texte', async () => {
    for (const [party, locale] of [[a, 'en'], [frAccount, 'fr']] as const) {
      const api = await seedApi(srv.db.url, party.user.id, { status: 'action_requise', strategy: false });
      const { runId } = await seedRun(srv.db.url, { apiId: api.id, ownerId: party.user.id, state: 'running', kind: 'investigation' });
      await stopRun(runId, api.id, 'instance_contact_missing', 'instance_contact_missing');
      const result = await call(await connect(party.key), 'get_run', { run_id: runId });
      const body = text(result);
      expect(result.structuredContent).toMatchObject({ state: 'action_required', status: 'action_requise', error: { code: 'instance_contact_missing', retryable: true } });
      expect(body).toContain('The run could not start (instance_contact_missing)');
      expect(body).toContain(actionTemplate(locale, 'instance_contact_missing'));
      expect(body).toContain('/settings/robot');
      expect(body).not.toMatch(/The investigation failed\.$|L’enquête a échoué\.$/m);
    }
  });

  test('create_api : enquête arrêtée pendant l’attente, le texte commence par l’état réel (UX-07) et le récit dit la cause dans la langue du compte', async () => {
    const client = await connect(frAccount.key);
    const before = await queuedInvestigations(frAccount);
    const pending = call(client, 'create_api', { description: 'zz_test contact absent', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    const { runId, apiId } = await nextInvestigation(frAccount, 10_000, before);
    await stopRun(runId, apiId, 'instance_contact_missing', 'instance_contact_missing');
    const result = await pending;
    const body = text(result);
    expect(result.structuredContent).toMatchObject({ run_state: 'failed', status: 'action_requise', error: { code: 'instance_contact_missing' } });
    expect(body).toMatch(/^API [a-z0-9-]+ created, but the investigation failed \(instance_contact_missing\): /);
    expect(body).not.toContain('the investigation is running');
    expect(body).toContain(actionTemplate('fr', 'instance_contact_missing'));
    expect(body).toContain('/settings/robot');
  });

  test('validate_schema : essais arrêtés faute de prix du modèle (llm_price_missing:<modèle>) : la cause, le modèle et le gabarit dans le texte, aucune stratégie annoncée', async () => {
    const client = await connect(a.key);
    const before = await queuedInvestigations(a);
    const sim = simulateFirstInvestigation(a, 30, before);
    await call(client, 'create_api', { description: 'zz_test prix absent', url: 'https://zz-books.example/catalogue/', auto_validate: false, force_new: true, wait_seconds: 5 });
    const { apiId } = await sim;
    const pending = call(client, 'validate_schema', { api_id: apiId, wait_seconds: 5 });
    const trial = await nextInvestigation(a, 10_000, before);
    await stopRun(trial.runId, trial.apiId, 'llm_price_missing', 'llm_price_missing:zz-model', { access: true });
    const body = text(await pending);
    expect(body).toContain('The run could not start (llm_price_missing)');
    expect(body).toContain('zz-model');
    expect(body).toContain(actionTemplate('en', 'llm_price_missing'));
    expect(body).toContain('/settings/models');
    expect(body).not.toMatch(/Strategy kept|Next step: call api_/);
  });
});

describe('cancel_run et report_problem (05 § 4.1, § 4.4)', () => {
  test('cancel_run sur une enquête en cours : état cancelled sous 5 s, coûts engagés imputés', async () => {
    const api = await seedApi(srv.db.url, a.user.id);
    const { runId } = await seedRun(srv.db.url, { apiId: api.id, ownerId: a.user.id, state: 'running', kind: 'investigation' });
    const client = await connect(a.key);
    const started = Date.now();
    const result = await call(client, 'cancel_run', { run_id: runId });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.structuredContent).toMatchObject({ run_id: runId, state: 'cancelled', cost: { total_usd: expect.any(Number) } });
    expect(await count("SELECT count(*) FROM runs WHERE id = $1 AND state = 'cancelled'", [runId])).toBe(1);
  });

  test('cancel_run et report_problem d’autrui : 404 uniforme', async () => {
    const api = await seedApi(srv.db.url, a.user.id);
    const { runId } = await seedRun(srv.db.url, { apiId: api.id, ownerId: a.user.id, state: 'running', kind: 'investigation' });
    const client = await connect(b.key);
    expect((JSON.parse(text(await call(client, 'cancel_run', { run_id: runId }))) as { code: string }).code).toBe('not_found');
    expect((JSON.parse(text(await call(client, 'report_problem', { slug: api.slug, note: 'zz_test' }))) as { code: string }).code).toBe('not_found');
  });
});

describe('assert_blocked_message_templates : messages fermés des statuts bloquee et action_requise', () => {
  const reasonOf = async (slug: string, reason: string) => withClient(srv.db.url, async (c) => void (await c.query('UPDATE apis SET status_reason = $2 WHERE slug = $1', [slug, reason])));

  test('API bloquée : le message est le gabarit fermé de sa raison, dans la langue de la personne, sans verbe de contournement', async () => {
    // D-91 : robots_disallowed n'est plus produit ; une API restée bloquée pour cette raison reçoit le gabarit par défaut.
    for (const reason of ['forbidden', 'blocked_by_protection', 'robots_disallowed']) {
      const api = await seedApi(srv.db.url, a.user.id, { status: 'bloquee' });
      await reasonOf(api.slug, reason);
      for (const lang of ['en', 'fr'] as const) {
        const result = await call(await connect(a.key, { lang }), 'run_api', { slug: api.slug, input: {} });
        expect(result.isError).toBe(true);
        expect(result).not.toHaveProperty('structuredContent');
        const err = JSON.parse(text(result)) as { code: string; message: string; what_to_do: string; retryable: boolean; next_action: unknown };
        expect(err).toMatchObject({ code: 'blocked', retryable: false, next_action: null, message: blockedTemplate(lang, reason) });
        expect(err.message).not.toMatch(/robots/i);
        expect(`${err.message} ${err.what_to_do}`).not.toMatch(BYPASS);
        expect(err.what_to_do).toMatch(/Do not retry/);
        expect(err.what_to_do).toMatch(/official API/);
      }
    }
  });

  test('API en action requise : gabarit fermé de la cause ; cause inconnue : gabarit par défaut', async () => {
    const known = await seedApi(srv.db.url, a.user.id, { status: 'action_requise' });
    await reasonOf(known.slug, 'cookie_expired');
    const err = JSON.parse(text(await call(await connect(a.key), 'run_api', { slug: known.slug, input: {} }))) as { code: string; message: string };
    expect(err).toMatchObject({ code: 'action_required', message: actionTemplate('en', 'cookie_expired') });
    const unknown = await seedApi(srv.db.url, a.user.id, { status: 'action_requise' });
    await reasonOf(unknown.slug, 'zz_test_hostile_reason_with_site_text');
    const other = JSON.parse(text(await call(await connect(a.key), 'run_api', { slug: unknown.slug, input: {} }))) as { message: string };
    expect(other.message).toBe(actionTemplate('en', null));
    expect(other.message).not.toContain('zz_test_hostile');
  });
});
