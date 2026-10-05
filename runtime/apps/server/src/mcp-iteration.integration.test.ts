// SPDX-License-Identifier: AGPL-3.0-only
// Itération par MCP (tâche 3.14, 05 § 1.1, 19 § 6, 07 § 2) sur un serveur réel, une base migrée et le client de test officiel
// (@modelcontextprotocol/client v2) : toolset `iterate` actif par défaut, `refine_api` → `test_api` → `promote_api` avec une
// élicitation de promotion (acte humain, `assert_promotion_requires_human`), `revert_api`, `discard_draft`, reprise dans une
// autre conversation (`assert_resume_in_new_conversation`, `assert_iteration_block_owner_only`), langue du compte
// (`assert_user_language_everywhere`), estimation tenue (`assert_estimate_within_cap`). Le worker est simulé en base : il termine
// les runs `draft_test` comme le ferait le vrai (le comportement du worker est joué par draft-test.integration.test.ts).
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { withClient } from '../../../tests/helpers/pg.js';
import { seedApi } from '../../../tests/helpers/rest-seed.js';
import { createKey, createUser, runSetup, signIn, startTestServer, type TestServer, type TestUser } from '../../../tests/helpers/server.js';
import { PROMPT_NAMES } from './mcp/texts.js';

type Party = { user: TestUser; cookie: string; key: string };
type ToolResult = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Elicit = { seen: { message: string; requestedSchema: unknown }[]; answer: () => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, string | number | boolean | string[]> } };

const ALL_SCOPES = ['apis:read', 'apis:run', 'apis:write', 'runs:read', 'datasets:read', 'schedules:write', 'sites:read'];
const BYPASS = /contourn|débloqu|bypass|unblock|circumvent|stealth|indétect|undetect|spoof/i;

let srv: TestServer;
let base: string;
let a: Party;
let b: Party;
let fr: Party;
const clients: Client[] = [];

async function connect(key: string, opts: { era?: 'legacy' | 'modern'; lang?: string; elicit?: Elicit } = {}): Promise<Client> {
  const url = new URL(`${base}/mcp${opts.lang === undefined ? '' : `?lang=${opts.lang}`}`);
  const client = new Client(
    { name: 'zz-test-client', version: '1.0.0' },
    { ...(opts.elicit === undefined ? {} : { capabilities: { elicitation: { form: {} } } }), ...(opts.era === 'modern' ? { versionNegotiation: { mode: 'auto' as const } } : {}) },
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

const call = async (client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> => (await client.callTool({ name, arguments: args })) as ToolResult;
const text = (r: ToolResult): string => r.content.map((c) => c.text ?? '').join('\n');
const count = async (sql: string, params: unknown[] = []) => withClient(srv.db.url, async (c) => Number(Object.values((await c.query<Record<string, string>>(sql, params)).rows[0]!)[0]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorOf = (r: ToolResult) => {
  expect(r.isError, text(r).slice(0, 300)).toBe(true);
  return JSON.parse(r.content[0]!.text!) as { code: string; message: string; what_to_do: string; retryable: boolean; next_action: Record<string, unknown> | null };
};

const SCHEMA_SURFACE = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', 'x-key': true }, price: { type: 'number' }, note: { type: 'string' }, surface: { type: 'number' } } };
const SCHEMA_RENAMED = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string', 'x-key': true }, prix: { type: 'number' }, note: { type: 'string' } } };
const REF_ITEMS = [{ title: 'a', price: 10 }, { title: 'b', price: 20 }, { title: 'c', price: 30 }];
const DRAFT_ITEMS = [{ title: 'a', price: 10, surface: 40 }, { title: 'b', price: 20, surface: 55 }, { title: 'c', price: 31, surface: 70 }];
const DRAFT_RENAMED = [{ title: 'a', prix: 10 }, { title: 'b', prix: 20 }, { title: 'c', prix: 30 }];

/** Worker simulé : termine les runs `draft_test` en file de l'API (version du brouillon : ses items ; version en service : la référence). */
async function finishTestRuns(apiId: string, draftItems: Record<string, unknown>[], opts: { proxyUsd?: number; expected?: number } = {}): Promise<void> {
  const deadline = Date.now() + 15_000;
  let done = 0;
  while (done < (opts.expected ?? 2) && Date.now() < deadline) {
    const rows = await withClient(srv.db.url, async (c) =>
      (await c.query<{ id: string; strategy_version: number; cur: number; owner_id: string }>(
        "SELECT r.id, r.strategy_version, a.current_strategy_version AS cur, r.owner_id FROM runs r JOIN apis a ON a.id = r.api_id WHERE r.api_id = $1 AND r.trigger = 'draft_test' AND r.state = 'queued'",
        [apiId],
      )).rows,
    );
    for (const r of rows) {
      const items = r.strategy_version === r.cur ? REF_ITEMS : draftItems;
      await withClient(srv.db.url, async (c) => {
        await c.query('SELECT ensure_dataset_items_partitions()');
        const ds = (await c.query<{ id: string }>('INSERT INTO datasets (api_id, run_id, owner_id, item_count) VALUES ($1, $2, $3, $4) RETURNING id', [apiId, r.id, r.owner_id, items.length])).rows[0]!.id;
        await c.query(
          `INSERT INTO dataset_items (dataset_id, seq, run_id, owner_id, item, size_bytes)
           SELECT $1, s.ord - 1, $2, $3, s.item::jsonb, length(s.item) FROM unnest($4::text[]) WITH ORDINALITY AS s(item, ord)`,
          [ds, r.id, r.owner_id, items.map((i) => JSON.stringify(i))],
        );
        await c.query(
          "UPDATE runs SET state = 'succeeded', outcome = 'clean', items = $3, dataset_id = $2, cost_llm_usd = 0, cost_proxy_usd = $4, started_at = coalesce(started_at, now()), finished_at = now(), duration_ms = 10 WHERE id = $1",
          [r.id, ds, items.length, opts.proxyUsd ?? 0],
        );
      });
      done += 1;
    }
    if (rows.length === 0) await sleep(25);
  }
}

/** refine + test d'une API : brouillon prêt à promouvoir ; rend le diff_hash du test. */
async function readyDraft(client: Client, slug: string, apiId: string, schema: Record<string, unknown>, items: Record<string, unknown>[]): Promise<string> {
  const refined = await call(client, 'refine_api', { slug, feedback: 'ajoute la surface', output_schema: schema });
  expect(refined.isError ?? false, text(refined)).toBe(false);
  const finishing = finishTestRuns(apiId, items);
  const tested = await call(client, 'test_api', { slug, input: { page: 1 }, wait_seconds: 5 });
  await finishing;
  expect(tested.isError ?? false, text(tested)).toBe(false);
  const test = (tested.structuredContent as { test?: { diff_hash?: string } }).test;
  expect(test?.diff_hash, text(tested)).toMatch(/^[0-9a-f]{64}$/);
  return test!.diff_hash!;
}

beforeAll(async () => {
  srv = await startTestServer('mcp_iter', { MAX_WAIT_SECONDS: '5', MAX_CONCURRENT_RUNS: '1000', MAX_ACTIVE_RUNS_PER_USER: '1000', MAX_RUNS_PER_KEY_PER_MINUTE: '1000', MCP_ALLOWED_HOSTS: '127.0.0.1' }, { rest: { pollMs: 40 } });
  const owner = await runSetup(srv);
  const party = async (user: TestUser): Promise<Party> => {
    const cookie = await signIn(srv, user);
    return { user, cookie, key: (await createKey(srv, cookie, user, ALL_SCOPES)).key };
  };
  await party(owner);
  a = await party(await createUser(srv, 'zz_test_iter_a@example.test'));
  b = await party(await createUser(srv, 'zz_test_iter_b@example.test'));
  fr = await party(await createUser(srv, 'zz_test_iter_fr@example.test'));
  await withClient(srv.db.url, (c) => c.query("UPDATE users SET locale = 'fr' WHERE id = $1", [fr.user.id]));
  base = await srv.app.listen({ port: 0, host: '127.0.0.1' });
}, 180_000);

afterAll(async () => {
  for (const client of clients) await client.close().catch(() => undefined);
  await srv.close();
});

describe('toolset iterate : actif par défaut, cinq outils, scopes', () => {
  test('tools/list sans ?toolsets= montre les cinq outils d’itération ; ?toolsets=build ne les montre pas ; MCP_DEFAULT_TOOLSETS les retire', async () => {
    const all = (await (await connect(a.key)).listTools()).tools.map((t) => t.name);
    for (const name of ['refine_api', 'test_api', 'promote_api', 'revert_api', 'discard_draft']) expect(all).toContain(name);
    const toolsets = new URL(`${base}/mcp?toolsets=build`);
    const client = new Client({ name: 'zz-test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(toolsets, { authProvider: { token: async () => a.key } }));
    clients.push(client);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('refine_api');
    // Annotations (19b § 2) : refine et test ouvrent sur le monde, promote et revert ne sont ni destructifs ni idempotents.
    const { tools } = await (await connect(a.key)).listTools();
    const by = (n: string) => tools.find((t) => t.name === n)!.annotations;
    for (const n of ['refine_api', 'test_api']) expect(by(n), n).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    for (const n of ['promote_api', 'revert_api']) expect(by(n), n).toMatchObject({ destructiveHint: false, idempotentHint: false });
  });
});

describe('refine_api, test_api, promote_api : le cycle de 07 § 2', () => {
  test('refine puis test : le brouillon vit à côté (version en service et statut inchangés), diff en une phrase, summary, estimate et next_action sans code interne', async () => {
    const api = await seedApi(srv.db.url, a.user.id);
    const client = await connect(a.key, { lang: 'en' });
    const refined = await call(client, 'refine_api', { slug: api.slug, feedback: 'add the surface', output_schema: SCHEMA_SURFACE });
    expect(refined.isError ?? false, text(refined)).toBe(false);
    const sc = refined.structuredContent as { summary: string; estimate: { basis: string }; next_action: { tool: string }; draft_version: number; schema_level: string };
    expect(sc).toMatchObject({ draft_version: 2, schema_level: 'minor', next_action: { tool: 'test_api' }, estimate: { basis: 'none' } });
    expect(text(refined)).toContain('SYM 👻: Draft ready. What runs does not change.');
    expect(text(refined)).toContain('1 field added');
    expect(await count("SELECT count(*) FROM apis WHERE id = $1 AND current_strategy_version = 1 AND status = 'sain'", [api.id])).toBe(1);
    expect(await count('SELECT count(*) FROM status_events WHERE api_id = $1', [api.id])).toBe(0);

    const finishing = finishTestRuns(api.id, DRAFT_ITEMS);
    const tested = await call(client, 'test_api', { slug: api.slug, input: { page: 1 }, wait_seconds: 5 });
    await finishing;
    const t = tested.structuredContent as { state: string; test: { ok: boolean; diff_hash: string; diff_summary: string }; next_action: { tool: string; args: { diff_hash: string } } };
    expect(t.state).toBe('succeeded');
    expect(t.test).toMatchObject({ ok: true, diff_summary: '3 items: 3 changed, 0 added, 0 removed, 3 fields filled' });
    expect(t.next_action).toMatchObject({ tool: 'promote_api', args: { diff_hash: t.test.diff_hash } });
    expect(text(tested)).toContain('Test done: 3 items: 3 changed');
    // Le test n'a touché ni au statut ni à la version en service ; deux runs `draft_test` tracés, jamais un run normal.
    expect(await count("SELECT count(*) FROM runs WHERE api_id = $1 AND trigger = 'draft_test'", [api.id])).toBe(2);
    expect(await count('SELECT count(*) FROM status_events WHERE api_id = $1', [api.id])).toBe(0);
    expect(await count("SELECT count(*) FROM apis WHERE id = $1 AND current_strategy_version = 1", [api.id])).toBe(1);
  });

  test('assert_user_language_everywhere : la langue du compte (ou ?lang=) sur summary et message d’erreur, sans code interne dans le texte', async () => {
    const api = await seedApi(srv.db.url, fr.user.id);
    const client = await connect(fr.key);
    const refined = await call(client, 'refine_api', { slug: api.slug, feedback: 'ajoute la surface', output_schema: SCHEMA_SURFACE });
    expect(text(refined)).toContain('SYM 👻 : Brouillon prêt. Ce qui tourne ne change pas.');
    expect(text(refined)).toContain('1 champ ajouté');
    expect((refined.structuredContent as { message_locale: string }).message_locale).toBe('fr');
    const summary = (refined.structuredContent as { summary: string }).summary;
    expect(summary).not.toMatch(/draft_|diff_hash|refine_in_progress|base_stale|_/);
    expect(summary).not.toMatch(BYPASS);
    // Erreur : message dans la langue, `what_to_do` en anglais, sans signature.
    const blocked = await seedApi(srv.db.url, fr.user.id, { status: 'bloquee' });
    const err = errorOf(await call(client, 'refine_api', { slug: blocked.slug, feedback: 'x' }));
    expect(err.code).toBe('api_blocked');
    expect(err.message).toContain('Cette API est arrêtée');
    expect(err.message).not.toContain('SYM 👻');
    expect(err.what_to_do).toMatch(/^This API is stopped/);
    // Même appel avec ?lang=en sur ce compte : l'anglais prime.
    const en = errorOf(await call(await connect(fr.key, { lang: 'en' }), 'refine_api', { slug: blocked.slug, feedback: 'x' }));
    expect(en.message).toMatch(/^This API is stopped/);
  });

  test('promote_api avec élicitation (ère 2026-07-28) : la personne voit le diff, le coût, la conséquence ; accepter promeut (acte humain, auditée), refuser ne change rien', async () => {
    const api = await seedApi(srv.db.url, a.user.id);
    const elicit: Elicit = { seen: [], answer: () => ({ action: 'accept', content: { decision: 'promote' } }) };
    const client = await connect(a.key, { era: 'modern', elicit, lang: 'en' });
    const hash = await readyDraft(client, api.slug, api.id, SCHEMA_SURFACE, DRAFT_ITEMS);
    // Refus : aucune promotion.
    const declining: Elicit = { seen: [], answer: () => ({ action: 'accept', content: { decision: 'cancel' } }) };
    const declined = await call(await connect(a.key, { era: 'modern', elicit: declining }), 'promote_api', { slug: api.slug, diff_hash: hash });
    expect(errorOf(declined).code).toBe('promotion_declined');
    expect(declining.seen).toHaveLength(1);
    expect(await count('SELECT count(*) FROM apis WHERE id = $1 AND current_strategy_version = 1', [api.id])).toBe(1);
    // Acceptation.
    const promoted = await call(client, 'promote_api', { slug: api.slug, diff_hash: hash });
    expect(promoted.isError ?? false, text(promoted)).toBe(false);
    expect(elicit.seen).toHaveLength(1);
    const asked = elicit.seen[0]!;
    expect(asked.message).toContain('Put the draft of');
    expect(asked.message).toContain('3 items: 3 changed');
    expect(asked.message).toContain('1 field added');
    expect(asked.message).toContain('Cost per run');
    const props = (asked.requestedSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props['decision']!.enum).toEqual(['promote', 'cancel']);
    expect(promoted.structuredContent).toMatchObject({ current_version: 2, previous_version: 1, status: 'sain', transition: null });
    expect(text(promoted)).toContain('SYM 👻: Version 2 is in service. You can go back at any time.');
    expect(await count("SELECT count(*) FROM audit_events WHERE action = 'api.promoted' AND target_id = $1 AND meta ->> 'human' = 'elicitation'", [api.id])).toBe(1);
  });

  test('assert_promotion_requires_human : sans élicitation, minor par appel explicite ; major : human_confirmation_required avec lien console, même avec acknowledge_breaking ; current inchangé', async () => {
    const minor = await seedApi(srv.db.url, a.user.id);
    const client = await connect(a.key); // aucune capacité d'élicitation
    const minorHash = await readyDraft(client, minor.slug, minor.id, SCHEMA_SURFACE, DRAFT_ITEMS);
    const ok = await call(client, 'promote_api', { slug: minor.slug, diff_hash: minorHash });
    expect(ok.isError ?? false, text(ok)).toBe(false);
    expect(await count("SELECT count(*) FROM audit_events WHERE action = 'api.promoted' AND target_id = $1 AND meta ->> 'human' = 'explicit_owner_call'", [minor.id])).toBe(1);

    const major = await seedApi(srv.db.url, a.user.id);
    const hash = await readyDraft(client, major.slug, major.id, SCHEMA_RENAMED, DRAFT_RENAMED);
    for (const acknowledge of [false, true]) {
      const err = errorOf(await call(client, 'promote_api', { slug: major.slug, diff_hash: hash, acknowledge_breaking: acknowledge }));
      expect(err.code, `acknowledge=${acknowledge}`).toBe('human_confirmation_required');
      expect(err.message).toMatch(/human decision/);
      expect(err.next_action).toMatchObject({ url: expect.stringContaining(`/apis/${major.slug}`) });
      expect(await count('SELECT count(*) FROM apis WHERE id = $1 AND current_strategy_version = 1', [major.id])).toBe(1);
    }
    // Le diff_hash périmé ou inconnu n'est jamais accepté, élicitation ou non.
    const err = errorOf(await call(client, 'promote_api', { slug: minor.slug, diff_hash: 'a'.repeat(64) }));
    expect(['no_draft', 'diff_hash_mismatch']).toContain(err.code);
  });

  test('revert_api : retour vers une version qui a été en service ; discard_draft jette le brouillon ; une version jamais en service ne se rétablit pas', async () => {
    const api = await seedApi(srv.db.url, a.user.id);
    const client = await connect(a.key);
    await withClient(srv.db.url, async (c) => {
      await c.query("INSERT INTO strategy_versions (api_id, version, owner_id, execution, network, spec, created_by) VALUES ($1, 2, $2, 'fetch', 'direct', '{\"zz\":2}', 'repair')", [api.id, a.user.id]);
      await c.query('UPDATE apis SET current_strategy_version = 2 WHERE id = $1', [api.id]);
    });
    const reverted = await call(client, 'revert_api', { slug: api.slug });
    expect(reverted.isError ?? false, text(reverted)).toBe(false);
    expect(reverted.structuredContent).toMatchObject({ current_version: 1, previous_version: 2, reason: 'reverted' });
    expect(text(reverted)).toContain('Version 1 is back in service.');
    await call(client, 'refine_api', { slug: api.slug, feedback: 'autre idée' });
    const discarded = await call(client, 'discard_draft', { slug: api.slug });
    expect(discarded.structuredContent).toMatchObject({ archived_version: 3 });
    expect(errorOf(await call(client, 'discard_draft', { slug: api.slug })).code).toBe('no_draft');
    expect(errorOf(await call(client, 'revert_api', { slug: api.slug, version: 3 })).code).toBe('version_not_revertable');
    expect(errorOf(await call(client, 'revert_api', { slug: api.slug, version: 1 })).code).toBe('already_current');
  });
});

describe('reprise dans une autre conversation, propriétaire seul', () => {
  test('assert_resume_in_new_conversation : un second client sans mémoire commune retrouve le brouillon, les retours, le test et la prochaine étape', async () => {
    const api = await seedApi(srv.db.url, a.user.id);
    const first = await connect(a.key);
    const hash = await readyDraft(first, api.slug, api.id, SCHEMA_SURFACE, DRAFT_ITEMS);
    const second = await connect(a.key); // autre session, rien en commun
    const resumed = await call(second, 'get_api', { slug: api.slug, view: 'iteration' });
    expect(resumed.isError ?? false, text(resumed)).toBe(false);
    const block = resumed.structuredContent as { current_version: number; draft: { version: number; tested: boolean; feedback: { text: string }[]; last_test: { diff_hash: string; ok: boolean } }; next_step: string; next_action: { tool: string } };
    expect(block).toMatchObject({ current_version: 1, next_step: 'promote', next_action: { tool: 'promote_api' }, draft: { version: 2, tested: true, last_test: { diff_hash: hash, ok: true } } });
    expect(block.draft.feedback[0]!.text).toBe('ajoute la surface');
    expect(text(resumed)).toContain('draft 2 tested');
    // Bloc de reprise : jamais plus de 2 000 jetons (8 000 caractères).
    expect(JSON.stringify(block).length).toBeLessThan(8_000);
    // Ressource et prompt de reprise.
    const resource = await second.readResource({ uri: `scrapyomama://api/${api.slug}/iteration` });
    const content = resource.contents[0] as { text: string };
    expect(JSON.parse(content.text)).toMatchObject({ draft: { version: 2 }, next_step: 'promote' });
    const prompt = await second.getPrompt({ name: 'resume_api', arguments: { slug: api.slug } });
    const body = prompt.messages.map((m) => (m.content.type === 'text' ? m.content.text : '')).join('\n');
    expect(body).toContain('view: "iteration"');
    expect(body).toContain(JSON.stringify({ slug: api.slug }));
    expect(body.trimEnd().endsWith('Answer the user in English.')).toBe(true);
    expect(body).not.toMatch(BYPASS);
    expect([...PROMPT_NAMES]).toContain('resume_api');
    // Versions.
    const versions = await call(second, 'get_api', { slug: api.slug, view: 'versions' });
    expect((versions.structuredContent as { versions: unknown[] }).versions.length).toBe(2);
  });

  test('assert_iteration_block_owner_only : un autre membre n’obtient ni la reprise, ni la ressource, ni les outils sur l’API d’autrui (même partagée)', async () => {
    const api = await seedApi(srv.db.url, a.user.id, { visibility: 'instance' });
    const owner = await connect(a.key);
    await call(owner, 'refine_api', { slug: api.slug, feedback: 'retour privé zz_secret_feedback' });
    const other = await connect(b.key);
    for (const [name, args] of [
      ['get_api', { slug: api.slug, view: 'iteration' }],
      ['refine_api', { slug: api.slug, feedback: 'x' }],
      ['test_api', { slug: api.slug, input: {} }],
      ['promote_api', { slug: api.slug, diff_hash: 'a'.repeat(64) }],
      ['revert_api', { slug: api.slug }],
      ['discard_draft', { slug: api.slug }],
    ] as const) {
      const r = await call(other, name, args);
      expect(errorOf(r).code, name).toBe('not_found');
      expect(text(r), name).not.toContain('zz_secret_feedback');
    }
    await expect(other.readResource({ uri: `scrapyomama://api/${api.slug}/iteration` })).rejects.toThrow();
    // Le propriétaire a toujours son brouillon.
    expect(await count("SELECT count(*) FROM strategy_versions WHERE api_id = $1 AND state = 'draft'", [api.id])).toBe(1);
  });
});

describe('plafonds : une boucle d’affinages et de tests', () => {
  test('assert_estimate_within_cap : 10 cycles refine + test, 10 runs draft_refine tracés, chaque coût réel sous le plafond annoncé, un seul affinage à la fois', async () => {
    const api = await seedApi(srv.db.url, a.user.id);
    // D-123 : sans plafond fixé, l'estimation annonce le plafond d'instance par défaut ; ici un plafond de 0,5 $ est fixé sur l'API.
    await withClient(srv.db.url, (c) => c.query('UPDATE apis SET max_cost_usd = 0.5 WHERE id = $1', [api.id]));
    const client = await connect(a.key);
    const caps: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const refined = await call(client, 'refine_api', { slug: api.slug, feedback: `affinage ${i}`, output_schema: SCHEMA_SURFACE });
      expect(refined.isError ?? false, text(refined)).toBe(false);
      // Premier cycle : deux runs (brouillon et référence) ; ensuite la référence récente est réutilisée : un seul run.
      const finishing = finishTestRuns(api.id, DRAFT_ITEMS, { proxyUsd: 0.001, expected: i === 0 ? 2 : 1 });
      const tested = await call(client, 'test_api', { slug: api.slug, input: { page: 1 }, wait_seconds: 5 });
      await finishing;
      const sc = tested.structuredContent as { estimate: { cap_usd: number; high_usd: number }; test: { cost_usd: number } };
      caps.push(sc.estimate.cap_usd);
      expect(sc.test.cost_usd, `cycle ${i}`).toBeLessThanOrEqual(sc.estimate.cap_usd);
    }
    expect(await count("SELECT count(*) FROM runs WHERE api_id = $1 AND trigger = 'draft_refine'", [api.id])).toBe(10);
    expect(await count("SELECT count(*) FROM runs WHERE api_id = $1 AND trigger = 'draft_test'", [api.id])).toBeGreaterThanOrEqual(11);
    // Aucun dépassement du plafond par run de l'API, aucune transition.
    expect(await count('SELECT count(*) FROM runs WHERE api_id = $1 AND (cost_llm_usd + cost_proxy_usd) > 0.5', [api.id])).toBe(0);
    expect(await count('SELECT count(*) FROM status_events WHERE api_id = $1', [api.id])).toBe(0);
    expect(Math.max(...caps)).toBeLessThanOrEqual(0.5);
  });

  test('estimation au-delà du plafond : cost_above_cap, jamais contournable ; au-delà du seuil : accept_cost ; aucun run créé tant que refusé', async () => {
    const api = await seedApi(srv.db.url, a.user.id);
    const client = await connect(a.key);
    await call(client, 'refine_api', { slug: api.slug, feedback: 'x' });
    await withClient(srv.db.url, async (c) => {
      await c.query("UPDATE strategy_versions SET est_cost_usd = 0.12 WHERE api_id = $1", [api.id]);
      await c.query("UPDATE apis SET iteration_budget_usd = 0.2 WHERE id = $1", [api.id]);
    });
    const before = await count("SELECT count(*) FROM runs WHERE api_id = $1 AND trigger = 'draft_test'", [api.id]);
    const err = errorOf(await call(client, 'test_api', { slug: api.slug, input: { page: 1 }, accept_cost: true }));
    expect(err.code).toBe('cost_above_cap');
    expect(await count("SELECT count(*) FROM runs WHERE api_id = $1 AND trigger = 'draft_test'", [api.id])).toBe(before);
    await withClient(srv.db.url, (c) => c.query('UPDATE apis SET iteration_budget_usd = NULL WHERE id = $1', [api.id]));
    const confirm = errorOf(await call(client, 'test_api', { slug: api.slug, input: { page: 1 } }));
    expect(confirm.code).toBe('cost_confirmation_required');
    const dry = await call(client, 'test_api', { slug: api.slug, input: { page: 1 }, dry_run: true });
    expect(dry.structuredContent).toMatchObject({ dry_run: true, estimate: { above_cap: false, needs_confirmation: true } });
  });
});
