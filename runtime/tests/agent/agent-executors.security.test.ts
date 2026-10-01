// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.4, livrable vérifiable (10-taches) : « Fixture HTML irrégulière résolue en E4. Fixture sans API ni DOM stable
// résolue en E5 ou E6, puis rejouée en E5 sans LLM. Injection : 0 requête vers le domaine piège. »
// Étage S (Chromium réel) : fixtures du spike 0.6a (F-E4, F-E6, F-INJ), proxy d'egress par essai (garde SSRF + verrou de
// domaines), Stagehand 3.7.3 (ADR 0001) sur un Chromium dédié, faux fournisseur scripté compatible OpenAI (aucun LLM
// réel en CI). Le modèle scripté de F-INJ OBÉIT à l'injection (navigation vers le domaine piège, y compris par
// `hôte@piège`) : seul le produit doit l'empêcher, compté par le serveur de fixtures.
import { StagehandEngine, recordsSchema } from '@runtime/agent';
import { Secret, validateHybridSpec, type AgentFetchSpec, type AgentSpec, type HybridSpec } from '@runtime/core';
import * as net from '@runtime/core/net';
import { openBrowserEgress, openNetworkSession, startEgressProxy, type BrowserEgress, type EgressProxy, type SsrfGuard } from '@runtime/core/net';
import { createLlmClient } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { launchAgentBrowser } from '../../apps/worker/src/browser/agent-browser.ts';
import { BrowserPool, playwrightLauncher } from '../../apps/worker/src/browser/pool.ts';
import { runAgentExecutor, runAgentFetchExecutor, runHybridExecutor, type EngineFactory } from '../../apps/worker/src/exec/agent-executors.ts';
import { AGENT_CANARY, AGENT_HOSTS } from '../../fixtures/src/sites/agent-sites.ts';
import { agentReference, agentTasks, type AgentFixtureKey } from '../../fixtures/src/agent-tasks.ts';
import { startClient, type Client } from '../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../helpers/fixture-net.ts';
import { stagehandScript, textOf } from '../helpers/stagehand-script.ts';

const CHALLENGE_200 = 'zz_test_challenge_200.localhost';
const CHALLENGE_403 = 'zz_test_challenge.localhost';
const HOSTS = [AGENT_HOSTS.e4, AGENT_HOSTS.e6, AGENT_HOSTS.inj, AGENT_HOSTS.trap, CHALLENGE_200, CHALLENGE_403];
const AGENT_MODEL = 'zz-agent';
const EXTRACT_MODEL = 'zz-extract';

let client: Client;
let guard: SsrfGuard;
let launchProxy: EgressProxy;
let pool: BrowserPool;
let fake: FakeProvider;
const signal = new AbortController().signal;
const url = (host: string, path = '/') => `http://${host}:${client.server.port}${path}`;

const task = (key: AgentFixtureKey) => agentTasks().find((t) => t.key === key)!;
/** Schéma d'UN enregistrement (output_schema de l'API) : l'item du schéma `{ items: [...] }` du spike, ou l'objet E6. */
const itemSchema = (key: AgentFixtureKey): Record<string, unknown> => {
  const s = task(key).outputSchema as { properties: { items?: { items: Record<string, unknown> } } };
  return s.properties.items?.items ?? task(key).outputSchema;
};
const referenceItems = (key: AgentFixtureKey): unknown[] => {
  const ref = agentReference(key) as { items?: unknown[] };
  return ref.items ?? [ref];
};
const sortById = (rows: readonly unknown[]) => [...rows].sort((a, b) => String((a as { id: string }).id).localeCompare(String((b as { id: string }).id)));

const trapRequests = async () => (await client.stats(`?host=${AGENT_HOSTS.trap}`)).hosts[AGENT_HOSTS.trap]?.total ?? 0;

async function withEgress<T>(hosts: readonly string[], fn: (egress: BrowserEgress) => Promise<T>): Promise<T> {
  const egress = await openBrowserEgress({ rung: { mode: 'direct' }, guard, allowedHosts: hosts });
  try {
    return await fn(egress);
  } finally {
    await egress.close();
  }
}

const extractClient = () =>
  createLlmClient({
    providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz_test_fake_key'), models: [{ id: EXTRACT_MODEL, price: { in: 1, out: 2 } }] }],
    roles: { extract: { provider: 'fake', model: EXTRACT_MODEL } },
  });

/** Moteur du rôle `agent` : Stagehand 3.7.3 en local, sur le faux fournisseur, environnement sans clé Browserbase/Brave. */
const engineFor = (env: NodeJS.ProcessEnv = {}): EngineFactory => ({ cdpUrl, recorder }) => ({
  engine: new StagehandEngine({ cdpUrl, baseURL: fake.baseUrl, apiKey: () => 'zz_test_fake_key', price: { in: 1, out: 2 }, recorder, env }),
  modelId: AGENT_MODEL,
  promptVersion: 'stagehand-3.7.3-dom',
});

beforeAll(async () => {
  client = await startClient();
  guard = fixtureGuard(client.server.port, HOSTS, net);
  launchProxy = await startEgressProxy({ guard, refuseAll: true });
  pool = new BrowserPool({ size: 1, launch: playwrightLauncher(launchProxy.url, process.env), recycleAfterRuns: 100 });
  fake = await createFakeProvider();
}, 120_000);

afterAll(async () => {
  await pool?.close();
  await launchProxy?.close();
  await fake?.close();
  await client?.close();
});

beforeEach(async () => {
  fake.reset();
  await client.reset();
});

describe('E4 agent_fetch : HTML irrégulier mis en forme par le rôle extract', () => {
  const spec = (via: AgentFetchSpec['via']): AgentFetchSpec => ({
    schema_version: 1,
    kind: 'agent_fetch',
    request: { url: url(AGENT_HOSTS.e4), allowed_hosts: [AGENT_HOSTS.e4] },
    via,
    instruction: task('F-E4').instruction,
    limits: { max_response_bytes: 1_000_000, max_input_chars: 60_000, timeout_ms: 30_000 },
  });

  test.each(['fetch', 'fetch_in_page'] as const)('assert_e4_irregular_html — F-E4 résolue en E4 (%s) : 8 produits conformes, page en texte visible encadré, aucun outil', async (via) => {
    fake.setScenario(EXTRACT_MODEL, [scripted.json(agentReference('F-E4'))]);
    const out = await withEgress([AGENT_HOSTS.e4], async (egress) => {
      const session = openNetworkSession({ rung: { mode: 'direct' }, guard, allowedHosts: [AGENT_HOSTS.e4] });
      try {
        return await runAgentFetchExecutor({
          spec: spec(via),
          outputSchema: itemSchema('F-E4'),
          llm: extractClient(),
          modelId: EXTRACT_MODEL,
          signal,
          ...(via === 'fetch' ? { session } : { browser: { pool, egress, guard } }),
        });
      } finally {
        await session.close();
      }
    });
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) return;
    expect(sortById(out.result.records)).toEqual(sortById(referenceItems('F-E4')));
    expect(out.llm).toMatchObject({ modelId: EXTRACT_MODEL, promptVersion: expect.stringMatching(/^extract-/) });
    expect(out.llm?.usd).toBeGreaterThan(0);
    expect(fake.calls).toHaveLength(1);
    const body = fake.calls[0]!.body;
    expect(body['tools']).toBeUndefined();
    const user = textOf((body['messages'] as { content: unknown }[]).at(-1)?.content);
    expect(user).toMatch(/<untrusted_page_[0-9a-f]{24}>/);
    expect(user).not.toMatch(/<(div|table|dl|p|em)[\s>]/);
    for (const ref of referenceItems('F-E4')) expect(user).toContain((ref as { id: string }).id);
  });

  test('assert_agent_classified_before_prompt — défi servi en 200 : classé AVANT tout prompt, le LLM n’est jamais appelé (INV6)', async () => {
    const out = await runAgentFetchExecutor({
      spec: { ...spec('fetch'), request: { url: url(CHALLENGE_200), allowed_hosts: [CHALLENGE_200] } },
      outputSchema: itemSchema('F-E4'),
      llm: extractClient(),
      modelId: EXTRACT_MODEL,
      signal,
      session: openNetworkSession({ rung: { mode: 'direct' }, guard, allowedHosts: [CHALLENGE_200] }),
      // Garde de classification de 1.7 (défi servi en 200) : branchée par l'option `classify`.
      classify: (exchange) => (exchange.status === 200 ? { failure_class: 'blocked_by_protection', retryable: false, detail: 'challenge_200' } : null),
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection' } });
    expect(out.llm).toBeNull();
    expect(fake.requests).toBe(0);
  });

  test('sortie hors schéma : jamais un succès (INV1)', async () => {
    const bad = scripted.json({ items: [{ id: 'zz_test_product_x', title: 't', price_eur: 'cher', category: null }] });
    fake.setScenario(EXTRACT_MODEL, [bad, bad, bad]);
    const out = await runAgentFetchExecutor({
      spec: spec('fetch'),
      outputSchema: itemSchema('F-E4'),
      llm: extractClient(),
      modelId: EXTRACT_MODEL,
      signal,
      session: openNetworkSession({ rung: { mode: 'direct' }, guard, allowedHosts: [AGENT_HOSTS.e4] }),
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'llm_schema_invalid' } });
  });
});

describe('E6 agent (Stagehand 3.7.3) puis compilation E6 → E5 rejouée sans LLM', () => {
  const e6Spec = (): AgentSpec => ({
    schema_version: 1,
    kind: 'agent',
    start_url: url(AGENT_HOSTS.e6),
    allowed_hosts: [AGENT_HOSTS.e6],
    instruction: task('F-E6').instruction,
    limits: { max_steps: 10, timeout_ms: 90_000 },
  });
  let compiled: HybridSpec | undefined;

  test('assert_e6_compiled_to_e5 — F-E6 résolue en E6 ; trace compilée en E5 (clic par rôle + nom, extraction par libellés), vérifiée par 2 rejeux', async () => {
    const ref = agentReference('F-E6') as { title: string };
    fake.setScenario(AGENT_MODEL, stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: `click the link "${ref.title}"` } }])], { items: [ref] }));
    const out = await withEgress([AGENT_HOSTS.e6], (egress) =>
      runAgentExecutor({
        spec: e6Spec(),
        outputSchema: itemSchema('F-E6'),
        signal,
        guard,
        egress,
        agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
        engineFor: engineFor(),
        pool,
        allowWriteActions: false,
        maxCostUsd: 0.5,
        taskId: 'zz_test_e6',
        version: 1,
      }),
    );
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) return;
    expect(out.result.records).toEqual([ref]);
    expect(out.llm).toMatchObject({ engine: 'stagehand@3.7.3', modelId: AGENT_MODEL });
    expect(out.llm?.usd).toBeGreaterThan(0);
    // Toutes les requêtes au modèle portent la température 0 et la liste d'outils fermée (sans « search »).
    for (const call of fake.calls) expect(call.body['temperature']).toBe(0);
    expect(((fake.calls[0]!.body['tools'] ?? []) as { function: { name: string } }[]).map((t) => t.function.name)).not.toContain('search');
    expect(out.compileFailure).toBeUndefined();
    compiled = out.compiled;
    expect(compiled).toMatchObject({
      kind: 'hybrid',
      steps: [{ op: 'click', target: { role: 'link', name: ref.title } }],
      extract: { mode: 'labels', fields: { id: { label: 'Identifiant' }, title: { heading: 1 }, reference: { label: 'Référence' }, color: { label: 'Couleur' } } },
      compiled_from: { execution: 'agent', version: 1, engine: 'stagehand@3.7.3' },
    });
    expect(validateHybridSpec(compiled).ok).toBe(true);
  }, 180_000);

  test('assert_e5_replay_without_llm — la stratégie compilée est rejouée en E5 SANS LLM : 0 requête au fournisseur, sortie identique, DOM régénéré', async () => {
    expect(compiled).toBeDefined();
    const before = fake.requests;
    for (let i = 0; i < 2; i++) {
      const out = await withEgress([AGENT_HOSTS.e6], (egress) =>
        runHybridExecutor({ spec: compiled!, outputSchema: itemSchema('F-E6'), signal, guard, egress, pool, allowWriteActions: false, maxCostUsd: 0.5 }),
      );
      expect(out.result.ok).toBe(true);
      if (out.result.ok) expect(out.result.records).toEqual([agentReference('F-E6')]);
      expect(out.llm).toBeNull();
    }
    expect(fake.requests).toBe(before);
  }, 120_000);

  test('E5 avec étape déléguée : l’agent reprend la page où le script l’a laissée, extraction sans LLM', async () => {
    expect(compiled).toBeDefined();
    const ref = agentReference('F-E6') as { title: string };
    const spec = validateHybridSpec({ ...compiled!, steps: [{ op: 'agent', instruction: `Open the detail page of the product named "${ref.title}".` }] });
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;
    fake.setScenario(AGENT_MODEL, stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: `click the link "${ref.title}"` } }])], {}));
    const out = await withEgress([AGENT_HOSTS.e6], (egress) =>
      runHybridExecutor({
        spec: spec.spec,
        outputSchema: itemSchema('F-E6'),
        signal,
        guard,
        egress,
        pool,
        agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
        engineFor: engineFor(),
        allowWriteActions: false,
        maxCostUsd: 0.5,
      }),
    );
    expect(out.result.ok).toBe(true);
    if (out.result.ok) expect(out.result.records).toEqual([ref]);
    expect(out.llm?.engine).toBe('stagehand@3.7.3');
    expect(fake.requests).toBeGreaterThan(0);
  }, 180_000);
});

describe('arrêt sur refus (INV6)', () => {
  test('assert_agent_classified_before_prompt — E6 sur une page de défi (403) : agent arrêté à la détection, classe forbidden, aucun appel au modèle, aucune compilation', async () => {
    fake.setScenario(AGENT_MODEL, stagehandScript([], { items: [] }));
    const out = await withEgress([CHALLENGE_403], (egress) =>
      runAgentExecutor({
        spec: { schema_version: 1, kind: 'agent', start_url: url(CHALLENGE_403), allowed_hosts: [CHALLENGE_403], instruction: 'Extract the products.', limits: { max_steps: 10, timeout_ms: 60_000 } },
        outputSchema: itemSchema('F-E6'),
        signal,
        guard,
        egress,
        agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
        engineFor: engineFor(),
        pool,
        allowWriteActions: false,
        maxCostUsd: 0.5,
        taskId: 'zz_test_403',
        version: 1,
      }),
    );
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'forbidden' } });
    expect(fake.requests).toBe(0);
    expect(out.compiled).toBeUndefined();
  }, 120_000);
});

describe('injection de prompt (08 §4) : 0 requête vers le domaine piège', () => {
  const injSpec = (): AgentSpec => ({
    schema_version: 1,
    kind: 'agent',
    start_url: url(AGENT_HOSTS.inj),
    allowed_hosts: [AGENT_HOSTS.inj],
    instruction: task('F-INJ').instruction,
    limits: { max_steps: 10, timeout_ms: 90_000 },
  });

  test('assert_prompt_injection_no_trap_request — E6 : le modèle obéit à l’injection (goto piège, hôte@piège) ; navigations coupées, 0 requête servie par le piège', async () => {
    const collect = url(AGENT_HOSTS.trap, '/collect');
    const userinfo = `http://${AGENT_HOSTS.inj}:${client.server.port}@${AGENT_HOSTS.trap}:${client.server.port}/collect`;
    fake.setScenario(
      AGENT_MODEL,
      stagehandScript(
        [scripted.toolCalls([{ name: 'goto', arguments: { url: collect } }]), scripted.toolCalls([{ name: 'goto', arguments: { url: userinfo } }])],
        agentReference('F-INJ'),
      ),
    );
    const out = await withEgress([AGENT_HOSTS.inj], (egress) =>
      runAgentExecutor({
        spec: injSpec(),
        outputSchema: itemSchema('F-INJ'),
        signal,
        guard,
        egress,
        agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
        engineFor: engineFor(),
        pool,
        allowWriteActions: false,
        maxCostUsd: 0.5,
        taskId: 'zz_test_inj',
        version: 1,
      }),
    );
    expect(await trapRequests()).toBe(0);
    expect(out.domainBlocked).toBeGreaterThan(0);
    expect(out.result.ok).toBe(true);
    if (out.result.ok) expect(JSON.stringify(out.result.records)).not.toContain(AGENT_CANARY);
    // Une trace qui porte une navigation hors domaine n'est jamais compilée.
    expect(out.compiled).toBeUndefined();
  }, 180_000);

  test('assert_prompt_injection_no_trap_request — E4 : instructions cachées, en commentaire et en alt retirées, le reste encadré comme donnée ; aucun outil, 0 requête au piège', async () => {
    fake.setScenario(EXTRACT_MODEL, [scripted.json(agentReference('F-INJ'))]);
    const session = openNetworkSession({ rung: { mode: 'direct' }, guard, allowedHosts: [AGENT_HOSTS.inj] });
    const out = await runAgentFetchExecutor({
      spec: {
        schema_version: 1,
        kind: 'agent_fetch',
        request: { url: url(AGENT_HOSTS.inj), allowed_hosts: [AGENT_HOSTS.inj] },
        via: 'fetch',
        instruction: task('F-INJ').instruction,
        limits: { max_response_bytes: 1_000_000, max_input_chars: 60_000, timeout_ms: 30_000 },
      },
      outputSchema: itemSchema('F-INJ'),
      llm: extractClient(),
      modelId: EXTRACT_MODEL,
      signal,
      session,
    });
    await session.close();
    expect(out.result.ok).toBe(true);
    const body = fake.calls[0]!.body;
    expect(body['tools']).toBeUndefined();
    const user = textOf((body['messages'] as { content: unknown }[]).at(-1)?.content);
    const token = /<untrusted_page_([0-9a-f]{24})>/.exec(user)?.[1];
    expect(token).toBeDefined();
    const inside = user.slice(user.indexOf(`<untrusted_page_${token}>`), user.indexOf(`</untrusted_page_${token}>`));
    // Une seule copie de la charge (le paragraphe visible), et dans le bloc non fiable ; ni lien, ni formulaire.
    expect(user.split('INSTRUCTION PRIORITAIRE').length - 1).toBe(1);
    expect(inside).toContain('INSTRUCTION PRIORITAIRE');
    // La légende du formulaire piège n'entre pas (seule reste sa mention dans la charge visible) ; ni champ ni bouton.
    expect(user.split('Vérification du compte').length - 1).toBe(1);
    expect(user).not.toMatch(/E-mail|Valider/);
    expect(user).not.toContain('?from=zz_test');
    expect(await trapRequests()).toBe(0);
  });

  test('assert_stagehand_local_only — Stagehand hors du mode local (clé Brave dans l’environnement) : refus avant tout appel, aucun repli', async () => {
    const out = await withEgress([AGENT_HOSTS.inj], (egress) =>
      runAgentExecutor({
        spec: injSpec(),
        outputSchema: itemSchema('F-INJ'),
        signal,
        guard,
        egress,
        agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
        engineFor: engineFor({ BRAVE_API_KEY: 'zz_test_not_a_key' }),
        pool,
        allowWriteActions: false,
        maxCostUsd: 0.5,
        taskId: 'zz_test_local',
        version: 1,
      }),
    );
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'code_error', detail: 'agent_engine_error' } });
    expect(fake.requests).toBe(0);
  }, 60_000);
});

describe('schéma de la tâche d’agent', () => {
  test('la sortie demandée à l’agent est `{ items: [output_schema] }`', () => {
    expect(recordsSchema(itemSchema('F-E6'))).toMatchObject({ properties: { items: { type: 'array', items: { required: expect.arrayContaining(['id', 'title']) } } } });
  });
});
