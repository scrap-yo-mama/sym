// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.4, livrable vérifiable (10-taches) : « Fixture HTML irrégulière résolue en E4. Fixture sans API ni DOM stable
// résolue en E5 ou E6, puis rejouée en E5 sans LLM. Injection : 0 requête vers le domaine piège. »
// Étage S (Chromium réel) : fixtures du spike 0.6a (F-E4, F-E6, F-INJ), proxy d'egress par essai (garde SSRF + verrou de
// domaines), Stagehand 3.7.3 (ADR 0001) sur un Chromium dédié, faux fournisseur scripté compatible OpenAI (aucun LLM
// réel en CI). Le modèle scripté de F-INJ OBÉIT à l'injection (navigation vers le domaine piège, y compris par
// `hôte@piège`, clic sur le lien piège, saisie et envoi du formulaire piège, canari dans la sortie) : seul le produit doit
// l'empêcher, compté par le serveur de fixtures. Correctifs de vérification : plafond de coût partagé et reliquat par
// étape, prix absent, défi servi en 200 classé avant tout appel au modèle, écritures refusées en E5 et en stratégie
// compilée, masquage `llm.redact` et jetons d'URL dans les prompts de Stagehand, compteur réseau de Node, service workers.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StagehandEngine, recordsSchema } from '@runtime/agent';
import { Secret, validateHybridSpec, type AgentFetchSpec, type AgentSpec, type HybridSpec } from '@runtime/core';
import * as net from '@runtime/core/net';
import { openBrowserEgress, openNetworkSession, startEgressProxy, type BrowserEgress, type EgressProxy, type SsrfGuard } from '@runtime/core/net';
import { createLlmClient, type ModelPrice, type RedactConfig } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider, type FakeRequestContext, type ScriptedResponse, type ScriptedStep } from '@runtime/llm/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { launchAgentBrowser, type AgentBrowser } from '../../apps/worker/src/browser/agent-browser.ts';
import type { RequestCheck } from '../../apps/worker/src/browser/request-guard.ts';
import { BrowserPool, type BrowserLauncher } from '../../apps/worker/src/browser/pool.ts';
import { createLocalProvider } from '../../apps/worker/src/browser/provider-local.ts';
import { runAgentExecutor, runAgentFetchExecutor, runHybridExecutor, type EngineFactory } from '../../apps/worker/src/exec/agent-executors.ts';
import { AGENT_CANARY, AGENT_HOSTS, AGENT_TRAP_TYPED_PATH } from '../../fixtures/src/sites/agent-sites.ts';
import { agentReference, agentTasks, type AgentFixtureKey } from '../../fixtures/src/agent-tasks.ts';
import { startClient, type Client } from '../../fixtures/src/test-helpers.ts';
import { fixtureGuard } from '../helpers/fixture-net.ts';
import { startNetMonitor } from '../helpers/net-monitor.ts';
import { stagehandScript, textOf } from '../helpers/stagehand-script.ts';

const CHALLENGE_200 = 'zz_test_challenge_200.localhost';
const CHALLENGE_403 = 'zz_test_challenge.localhost';
const HOSTS = [AGENT_HOSTS.e4, AGENT_HOSTS.e5, AGENT_HOSTS.e6, AGENT_HOSTS.inj, AGENT_HOSTS.trap, CHALLENGE_200, CHALLENGE_403];
/** Serveur local du test (écritures en XHR, données personnelles, service worker) : hors du serveur de fixtures. */
const LOCAL = 'zz_test_agent_local.localhost';
/** Second domaine autorisé, d'un AUTRE site que LOCAL : son cadre tourne hors processus (site-per-process). */
const OTHER = 'zz_test_agent_other.example';
const AGENT_MODEL = 'zz-agent';
const EXTRACT_MODEL = 'zz-extract';

let client: Client;
let guard: SsrfGuard;
let launchProxy: EgressProxy;
let pool: BrowserPool;
let fake: FakeProvider;
let local: { server: Server; port: number; posts: number; paths: string[]; releaseHang: () => void; resetHang: () => void };
let localGuard: SsrfGuard;
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

const typedRequests = async () => (await client.stats(`?host=${AGENT_HOSTS.inj}`)).hosts[AGENT_HOSTS.inj]?.paths[AGENT_TRAP_TYPED_PATH] ?? 0;
const localUrl = (path = '/') => `http://${LOCAL}:${local.port}${path}`;

async function withEgress<T>(hosts: readonly string[], fn: (egress: BrowserEgress) => Promise<T>, g: SsrfGuard = guard): Promise<T> {
  const egress = await openBrowserEgress({ rung: { mode: 'direct' }, guard: g, allowedHosts: hosts });
  try {
    return await fn(egress);
  } finally {
    await egress.close();
  }
}

/** Prix du faux fournisseur : l'usage par défaut (10 jetons en entrée, 5 en sortie) coûte 0,02 $ par appel au prix « cher ». */
const CHEAP: ModelPrice = { in: 1, out: 2 };
const DEAR: ModelPrice = { in: 1000, out: 2000 };
const CALL_USD = 0.02;

const extractClient = (price: ModelPrice | null = CHEAP) =>
  createLlmClient({
    providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz_test_fake_key'), models: [{ id: EXTRACT_MODEL, ...(price === null ? {} : { price }) }] }],
    roles: { extract: { provider: 'fake', model: EXTRACT_MODEL } },
  });

/** Moteur du rôle `agent` : Stagehand 3.7.3 en local, sur le faux fournisseur, environnement sans clé Browserbase/Brave. */
const engineFor =
  (o: { env?: NodeJS.ProcessEnv; price?: ModelPrice | null; redact?: RedactConfig; model?: string; onSamplingRejected?: (param: 'temperature' | 'top_p') => void } = {}): EngineFactory =>
  ({ cdpUrl, recorder, hooks }) => ({
    engine: new StagehandEngine({
      cdpUrl,
      baseURL: fake.baseUrl,
      apiKey: () => 'zz_test_fake_key',
      price: o.price === null ? undefined : (o.price ?? CHEAP),
      recorder,
      env: o.env ?? {},
      ...(o.redact === undefined ? {} : { redact: o.redact }),
      ...(o.onSamplingRejected === undefined ? {} : { onSamplingRejected: o.onSamplingRejected }),
      ...hooks,
    }),
    modelId: o.model ?? AGENT_MODEL,
    promptVersion: 'stagehand-3.7.3-dom',
  });

/**
 * Réponses du faux fournisseur avec l'usage brut choisi : `null`, aucun usage (fournisseur qui n'en renvoie pas) ;
 * `{ cost }` seul (OpenRouter : `usage.cost` fait foi, 08 §1). Même corps que le faux, usage mis à part.
 */
function withRawUsage(steps: ScriptedStep[], usage: Record<string, unknown> | null): ScriptedStep[] {
  return steps.map((step) => (ctx: FakeRequestContext): ScriptedResponse => {
    const res = typeof step === 'function' ? step(ctx) : step;
    if (res.kind !== 'completion') return res;
    const message: Record<string, unknown> = { role: 'assistant', content: res.content ?? null };
    if (res.toolCalls !== undefined) {
      message['tool_calls'] = res.toolCalls.map((c, i) => ({
        id: c.id ?? `call_${ctx.step}_${i}`,
        type: 'function',
        function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments) },
      }));
    }
    const body = { id: `zz-raw-${ctx.step}`, object: 'chat.completion', model: AGENT_MODEL, choices: [{ index: 0, message, finish_reason: res.finishReason ?? 'stop' }] };
    return scripted.raw('application/json', JSON.stringify(usage === null ? body : { ...body, usage }));
  });
}

/**
 * Pages du serveur local : / (fiche + bouton « Envoyer » qui écrit en XHR POST), /contact (e-mail, téléphone, lien à
 * jeton), /sw (enregistre un service worker), /sw.js. Les POST sont comptés côté serveur, quel que soit le chemin.
 */
async function startLocalServer(): Promise<typeof local> {
  const state = { posts: 0, paths: [] as string[] };
  const page = (title: string, body: string) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    state.paths.push(`${req.method} ${path}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      state.posts += 1;
      req.resume();
      res.writeHead(204).end();
      return;
    }
    const send = (body: string, type = 'text/html; charset=utf-8') => res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }).end(body);
    if (path === '/') {
      return send(
        page(
          'Fiche zz_test',
          '<h1>Lampe zz_test</h1><p>Identifiant : zz_test_item_0001</p>' +
            '<button type="button" onclick="fetch(\'/write\',{method:\'POST\',body:\'zz_test\'}).catch(function(){});navigator.sendBeacon(\'/beacon\',\'zz_test\')">Envoyer</button>',
        ),
      );
    }
    if (path === '/contact') {
      return send(
        page(
          'Contact zz_test',
          '<h1>Contact zz_test</h1><p>Identifiant : zz_test_item_0002</p><p>Écrire à zz_test_jane@example.invalid ou appeler le +33 1 23 45 67 89.</p>' +
            '<p><a href="/suite?token=zz_secret_token_42">Suite</a></p>',
        ),
      );
    }
    // Navigation qui mène à un défi (tâche 2.10, assert_rules_cannot_widen variante E6) : lien « Continuer » puis interstitiel.
    if (path === '/defi-lien') return send(page('Fiche zz_test', '<h1>Lampe zz_test</h1><p><a href="/defi">Continuer</a></p>'));
    if (path === '/defi') return send(page('Just a moment...', '<h1>Checking your browser</h1><p>Please verify you are human.</p><button type="button">Verify</button>'));
    // Envoi de formulaire POST (navigation, pas un XHR) : son `requestWillBeSent` vient du processus du navigateur, après l'IPC.
    if (path === '/formpost') return send(page('Formulaire zz_test', '<h1>Formulaire</h1><form action="/write" method="post"><input name="code" value="zz_test"><button type="submit">Valider</button></form>'));
    if (path === '/sw') return send(page('SW zz_test', '<h1>SW</h1>'));
    if (path === '/sw.js') return send("self.addEventListener('fetch', function () {});", 'text/javascript');
    // Écritures hors de la session CDP de la page : worker dédié, cadre d'un autre site (hors processus).
    if (path === '/worker') return send(page('Worker zz_test', "<h1>Worker</h1><script>new Worker('/worker.js')</script>"));
    if (path === '/worker.js') return send("fetch('/wwrite',{method:'POST',body:'zz_test'}).catch(function(){});", 'text/javascript');
    if (path === '/frame') return send(page('Cadre zz_test', `<h1>Cadre</h1><iframe src="http://${OTHER}:${(server.address() as AddressInfo).port}/inner"></iframe>`));
    if (path === '/inner') return send(page('Interne zz_test', "<p>interne</p><script>fetch('/fwrite',{method:'POST',body:'zz_test'}).catch(function(){})</script>"));
    // Fiche dont le bouton écrit puis fait boucler le fil principal de la page dès que /hang répond (fin de l'agent).
    if (path === '/loop') {
      return send(
        page(
          'Fiche zz_test',
          '<h1>Lampe zz_test</h1><p>Identifiant : zz_test_item_0001</p>' +
            "<button type=\"button\" onclick=\"fetch('/write',{method:'POST',body:'zz_test'}).catch(function(){});fetch('/hang').then(function(){for(;;){}})\">Envoyer</button>",
        ),
      );
    }
    if (path === '/hang') {
      void hang.then(() => send('ok', 'text/plain'));
      return;
    }
    res.writeHead(404).end();
  });
  let releaseHang = (): void => undefined;
  let hang = new Promise<void>((resolve) => (releaseHang = resolve));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return Object.defineProperties({ server, port: (server.address() as AddressInfo).port } as typeof local, {
    posts: { get: () => state.posts },
    paths: { get: () => state.paths },
    releaseHang: { value: () => releaseHang() },
    resetHang: { value: () => void (hang = new Promise<void>((resolve) => (releaseHang = resolve))) },
  });
}
const LOCAL_ITEM = { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'], additionalProperties: false };

beforeAll(async () => {
  client = await startClient();
  guard = fixtureGuard(client.server.port, HOSTS, net);
  launchProxy = await startEgressProxy({ guard, refuseAll: true });
  pool = new BrowserPool({ size: 1, launch: createLocalProvider({ launchProxyUrl: launchProxy.url, env: process.env }).launchShared, recycleAfterRuns: 100 });
  fake = await createFakeProvider();
  local = await startLocalServer();
  localGuard = fixtureGuard(local.port, [LOCAL, OTHER], net);
}, 120_000);

afterAll(async () => {
  await pool?.close();
  await launchProxy?.close();
  await fake?.close();
  await client?.close();
  local?.releaseHang();
  await new Promise((resolve) => local?.server.close(resolve));
});

beforeEach(async () => {
  fake.reset();
  await client.reset();
  local.paths.length = 0;
  local.resetHang();
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
          maxCostUsd: 0.5,
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

  test('assert_agent_classified_before_prompt — défi servi en 200 : classé AVANT tout prompt par le classifieur de 1.7, le LLM n’est jamais appelé (INV6)', async () => {
    const out = await runAgentFetchExecutor({
      spec: { ...spec('fetch'), request: { url: url(CHALLENGE_200), allowed_hosts: [CHALLENGE_200] } },
      outputSchema: itemSchema('F-E4'),
      llm: extractClient(),
      modelId: EXTRACT_MODEL,
      signal,
      maxCostUsd: 0.5,
      session: openNetworkSession({ rung: { mode: 'direct' }, guard, allowedHosts: [CHALLENGE_200] }),
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
      maxCostUsd: 0.5,
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

  test('assert_e6_compiled_to_e5 / assert_stagehand_local_only — F-E6 résolue en E6 ; trace compilée en E5 (clic par rôle + nom, extraction par libellés), vérifiée par 2 rejeux ; Node ne contacte que la boucle locale (ni Browserbase ni Brave)', async () => {
    const ref = agentReference('F-E6') as { title: string };
    fake.setScenario(AGENT_MODEL, stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: `click the link "${ref.title}"` } }])], { items: [ref] }));
    const monitor = startNetMonitor();
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
    ).finally(() => monitor.stop());
    // Compteur réseau du processus (même harnais que le spike, stagehand.contract.test.ts) : 0 hôte hors boucle locale
    // (faux fournisseur, fixtures, proxy d'egress), ni Browserbase ni Brave, sur le moteur construit comme en production.
    expect(monitor.events.length).toBeGreaterThan(0);
    expect(monitor.offsite()).toEqual([]);
    expect(monitor.events.some((e) => /browserbase|brave/i.test(e.host))).toBe(false);
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

describe('E6 sans profil sondé (production avant la route de sonde) : 400 qui nomme temperature (claude-opus-4-8 compatible OpenAI)', () => {
  test('le moteur réessaie sans temperature, le signale une fois et ne l’envoie plus pendant le run', async () => {
    const ref = agentReference('F-E6') as { title: string };
    const deprecated = scripted.error(400, { error: { message: '`temperature` is deprecated for this model.', type: 'invalid_request_error' } });
    fake.setScenario(AGENT_MODEL, [deprecated, ...stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: `click the link "${ref.title}"` } }])], { items: [ref] })]);
    const rejected: string[] = [];
    const out = await withEgress([AGENT_HOSTS.e6], (egress) =>
      runAgentExecutor({
        spec: { schema_version: 1, kind: 'agent', start_url: url(AGENT_HOSTS.e6), allowed_hosts: [AGENT_HOSTS.e6], instruction: task('F-E6').instruction, limits: { max_steps: 10, timeout_ms: 90_000 } },
        outputSchema: itemSchema('F-E6'),
        signal,
        guard,
        egress,
        agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
        engineFor: engineFor({ onSamplingRejected: (param) => void rejected.push(param) }),
        pool,
        allowWriteActions: false,
        maxCostUsd: 0.5,
        taskId: 'zz_test_e6_sampling',
        version: 1,
      }),
    );
    expect(out.result.ok).toBe(true);
    expect(rejected).toEqual(['temperature']);
    expect(fake.calls[0]!.body['temperature']).toBe(0);
    expect(fake.calls.length).toBeGreaterThan(2);
    for (const call of fake.calls.slice(1)) expect(call.body).not.toHaveProperty('temperature');
  }, 180_000);
});

describe('arrêt sur refus (INV6)', () => {
  // Depuis la fusion de 1.7, la page de défi servie en 403 est reconnue par le classifieur : blocked_by_protection.
  test('assert_agent_classified_before_prompt — E6 sur une page de défi (403) : agent arrêté à la détection, classe blocked_by_protection, aucun appel au modèle, aucune compilation', async () => {
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
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection' } });
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

  test('assert_prompt_injection_no_trap_request — E6 : le modèle clique « Vérifier mon compte », remplit et envoie le formulaire piège, puis écrit le canari ; 0 requête au piège, 0 saisie comptée, canari jamais rendu', async () => {
    const legit = agentReference('F-INJ') as { items: Record<string, unknown>[] };
    fake.setScenario(
      AGENT_MODEL,
      stagehandScript(
        [
          // Saisie d'abord (la page est encore là), puis le lien piège (navigation coupée : page d'erreur), retour sur la
          // boutique, puis l'envoi du formulaire piège.
          scripted.toolCalls([{ name: 'act', arguments: { action: 'type "zz_test_victim@example.invalid" into the textbox "E-mail"' } }]),
          scripted.toolCalls([{ name: 'act', arguments: { action: 'click the link "Vérifier mon compte"' } }]),
          scripted.toolCalls([{ name: 'goto', arguments: { url: url(AGENT_HOSTS.inj) } }]),
          scripted.toolCalls([{ name: 'act', arguments: { action: 'click the button "Valider"' } }]),
        ],
        // Le modèle obéit jusqu'au bout : le canari est écrit dans la sortie, hors du schéma de l'API.
        { items: legit.items.map((item, i) => (i === 0 ? { ...item, note: AGENT_CANARY } : item)) },
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
        taskId: 'zz_test_inj_form',
        version: 1,
      }),
    );
    // Le modèle a bien demandé les trois actions (le test n'est pas vide) : 3 inférences « finding elements ».
    const inferences = fake.calls.filter((c) => textOf((c.body['messages'] as { content: unknown }[])[0]?.content).includes('finding elements'));
    expect(inferences.length).toBeGreaterThanOrEqual(3);
    expect(await trapRequests()).toBe(0);
    // Aucune saisie dans le formulaire piège n'atteint la page (compteur de la fixture sur l'événement input).
    expect(await typedRequests()).toBe(0);
    expect(JSON.stringify(out.result)).not.toContain(AGENT_CANARY);
    expect(out.result.ok).toBe(false);
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
      maxCostUsd: 0.5,
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
        engineFor: engineFor({ env: { BRAVE_API_KEY: 'zz_test_not_a_key' } }),
        pool,
        allowWriteActions: false,
        maxCostUsd: 0.5,
        taskId: 'zz_test_local',
        version: 1,
      }),
    );
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'code_error', detail: 'agent_engine_error' } });
    expect(fake.requests).toBe(0);
  }, 120_000); // lancement du Chromium dédié compris (CHROMIUM_LAUNCH_TIMEOUT_MS = 60 s), comme les autres essais E5/E6 du fichier
});

describe('plafond de coût de l’essai (04b « Schéma et coût », 08 §1) : reliquat, prix absent', () => {
  const ref = () => agentReference('F-E6') as { title: string };
  /** Extraction par libellés de F-E6 (celle qu'induit la compilation) : aucune dépendance au test de compilation. */
  const e6Labels = { id: { label: 'Identifiant' }, title: { heading: 1 }, reference: { label: 'Référence' }, color: { label: 'Couleur' } };
  const hybrid = (steps: unknown[], extract: unknown = { mode: 'labels', fields: e6Labels }): HybridSpec => {
    const c = validateHybridSpec({ schema_version: 1, kind: 'hybrid', start_url: url(AGENT_HOSTS.e6), allowed_hosts: [AGENT_HOSTS.e6], steps, extract });
    if (!c.ok) throw new Error(c.errors.join(' ; '));
    return c.spec;
  };

  test('assert_run_cost_capped — E5 à 2 étapes agent et extraction déléguée, max_cost_usd = 0,10 $ : la 2e étape reçoit le reliquat, l’extraction n’est pas appelée, coût imputé ≤ plafond', async () => {
    // 4 appels de 0,02 $ pour la 1re étape (tour, inférence du clic, tour final, « done » forcé) : 0,08 $.
    fake.setScenario(AGENT_MODEL, stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: `click the link "${ref().title}"` } }])], {}));
    fake.setScenario(EXTRACT_MODEL, [scripted.json({ items: [agentReference('F-E6')] })]);
    const maxCostUsd = 0.1;
    const out = await withEgress([AGENT_HOSTS.e6], (egress) =>
      runHybridExecutor({
        spec: hybrid(
          [
            { op: 'agent', instruction: `Open the detail page of the product named "${ref().title}".` },
            { op: 'agent', instruction: 'Scroll to the product characteristics.' },
          ],
          { mode: 'agent', instruction: task('F-E6').instruction },
        ),
        outputSchema: itemSchema('F-E6'),
        signal,
        guard,
        egress,
        pool,
        agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
        engineFor: engineFor({ price: DEAR }),
        llm: extractClient(DEAR),
        llmModelId: EXTRACT_MODEL,
        allowWriteActions: false,
        maxCostUsd,
      }),
    );
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'run_budget_exceeded' } });
    expect(out.llm?.usd).not.toBeNull();
    expect(out.llm!.usd!).toBeLessThanOrEqual(maxCostUsd + 1e-9);
    expect(fake.byRole[AGENT_MODEL] ?? 0).toBeLessThanOrEqual(Math.round(maxCostUsd / CALL_USD));
    expect(fake.byRole[EXTRACT_MODEL] ?? 0).toBe(0);
  }, 180_000);

  test('assert_run_cost_capped — E4 : le client du rôle extract est plafonné ; une réparation qui dépasserait le reliquat n’est pas envoyée', async () => {
    // Recette 2026-10-04 (UX-32), banc réel R06 : le contrôle compte la borne HAUTE de l'envoi (entrée réelle, sortie au
    // max_tokens de 8 192 jetons, soit 0,0164 $ au prix « bon marché »). Plafond de 0,02 $ : le premier appel part ; sa réponse
    // hors schéma de 4 000 jetons coûte 0,008 $ ; la réparation, dont la borne haute franchirait le reliquat, n'est jamais
    // envoyée (avant UX-32 : envoyée, 0,016 $ facturés).
    const bad = scripted.json({ items: [{ id: 'zz_test_product_x', title: 't', price_eur: 'cher', category: null }] }, { prompt_tokens: 10, completion_tokens: 4_000 });
    fake.setScenario(EXTRACT_MODEL, [bad, bad, bad]);
    const out = await runAgentFetchExecutor({
      spec: {
        schema_version: 1,
        kind: 'agent_fetch',
        request: { url: url(AGENT_HOSTS.e4), allowed_hosts: [AGENT_HOSTS.e4] },
        via: 'fetch',
        instruction: task('F-E4').instruction,
        limits: { max_response_bytes: 1_000_000, max_input_chars: 60_000, timeout_ms: 30_000 },
      },
      outputSchema: itemSchema('F-E4'),
      llm: extractClient(CHEAP),
      modelId: EXTRACT_MODEL,
      signal,
      maxCostUsd: 0.02,
      session: openNetworkSession({ rung: { mode: 'direct' }, guard, allowedHosts: [AGENT_HOSTS.e4] }),
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'run_budget_exceeded', detail: 'max_cost_usd' } });
    expect(fake.requests).toBe(1);
    expect(out.llm?.usd).not.toBeNull();
    expect(out.llm!.usd!).toBeLessThanOrEqual(0.02);
  });

  test('assert_llm_cost_null_when_price_missing — E6 sans prix du modèle : arrêt après le premier appel, coût null (jamais 0), classe run_budget_exceeded (llm_price_missing)', async () => {
    fake.setScenario(AGENT_MODEL, stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: `click the link "${ref().title}"` } }])], { items: [ref()] }));
    const out = await withEgress([AGENT_HOSTS.e6], (egress) =>
      runAgentExecutor({
        spec: { schema_version: 1, kind: 'agent', start_url: url(AGENT_HOSTS.e6), allowed_hosts: [AGENT_HOSTS.e6], instruction: task('F-E6').instruction, limits: { max_steps: 10, timeout_ms: 90_000 } },
        outputSchema: itemSchema('F-E6'),
        signal,
        guard,
        egress,
        agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
        engineFor: engineFor({ price: null }),
        pool,
        allowWriteActions: false,
        maxCostUsd: 0.5,
        taskId: 'zz_test_unpriced',
        version: 1,
      }),
    );
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'run_budget_exceeded', detail: 'llm_price_missing' } });
    expect(out.llm?.usd).toBeNull();
    expect(fake.requests).toBe(1);
    expect(out.compiled).toBeUndefined();
  }, 120_000);

  test('assert_llm_cost_null_when_price_missing — E4 sans prix du modèle : coût null, jamais un succès dont le coût est inconnu', async () => {
    fake.setScenario(EXTRACT_MODEL, [scripted.json(agentReference('F-E4'))]);
    const out = await runAgentFetchExecutor({
      spec: {
        schema_version: 1,
        kind: 'agent_fetch',
        request: { url: url(AGENT_HOSTS.e4), allowed_hosts: [AGENT_HOSTS.e4] },
        via: 'fetch',
        instruction: task('F-E4').instruction,
        limits: { max_response_bytes: 1_000_000, max_input_chars: 60_000, timeout_ms: 30_000 },
      },
      outputSchema: itemSchema('F-E4'),
      llm: extractClient(null),
      modelId: EXTRACT_MODEL,
      signal,
      maxCostUsd: 0.5,
      session: openNetworkSession({ rung: { mode: 'direct' }, guard, allowedHosts: [AGENT_HOSTS.e4] }),
    });
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'run_budget_exceeded', detail: 'llm_price_missing' } });
    expect(out.llm?.usd).toBeNull();
    expect(fake.requests).toBe(1);
  });

  test('assert_stagehand_cost_from_raw_usage — E6, fournisseur sans usage : jetons estimés d’après la taille du prompt et de la réponse, coût jamais 0 ; l’appel dont le coût prévu dépasse max_cost_usd n’est pas envoyé (UX-32)', async () => {
    const run = (maxCostUsd: number, taskId: string) => {
      fake.reset();
      fake.setScenario(AGENT_MODEL, withRawUsage(stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: `click the link "${ref().title}"` } }])], { items: [ref()] }), null));
      return withEgress([AGENT_HOSTS.e6], (egress) =>
        runAgentExecutor({
          spec: { schema_version: 1, kind: 'agent', start_url: url(AGENT_HOSTS.e6), allowed_hosts: [AGENT_HOSTS.e6], instruction: task('F-E6').instruction, limits: { max_steps: 10, timeout_ms: 90_000 } },
          outputSchema: itemSchema('F-E6'),
          signal,
          guard,
          egress,
          agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
          engineFor: engineFor({ price: DEAR }),
          pool,
          allowWriteActions: false,
          maxCostUsd,
          taskId,
          version: 1,
        }),
      );
    };
    // Plafond large : les appels partent ; sans usage du fournisseur, le coût vient des tailles (jamais 0).
    const wide = await run(1_000, 'zz_test_no_usage');
    expect(wide.llm?.usd).not.toBeNull();
    expect(wide.llm!.usd!).toBeGreaterThan(0);
    expect(wide.llm?.tokens.estimated).toBe(true);
    expect(wide.llm!.tokens.in).toBeGreaterThan(0);
    // Prix « cher » : le premier prompt de Stagehand (plusieurs milliers de caractères) coûterait à lui seul plus de 0,50 $ :
    // il n'est pas envoyé (avant UX-32 : envoyé, puis plus de 0,50 $ facturés).
    const capped = await run(0.5, 'zz_test_no_usage_capped');
    expect(capped.result).toMatchObject({ ok: false, failure: { failure_class: 'run_budget_exceeded', detail: 'max_cost_usd' } });
    expect(fake.byRole[AGENT_MODEL] ?? 0).toBe(0);
    expect(capped.llm?.usd ?? 0).toBeLessThanOrEqual(0.5);
    expect(capped.compiled).toBeUndefined();
  }, 240_000);

  test('assert_stagehand_cost_from_raw_usage — E6, usage.cost seul (OpenRouter) et modèle sans prix configuré : coût du fournisseur retenu (08 §1), jamais llm_price_missing', async () => {
    const PROVIDER_USD = 0.001;
    fake.setScenario(AGENT_MODEL, withRawUsage(stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: `click the link "${ref().title}"` } }])], { items: [ref()] }), { cost: PROVIDER_USD }));
    const out = await withEgress([AGENT_HOSTS.e6], (egress) =>
      runAgentExecutor({
        spec: { schema_version: 1, kind: 'agent', start_url: url(AGENT_HOSTS.e6), allowed_hosts: [AGENT_HOSTS.e6], instruction: task('F-E6').instruction, limits: { max_steps: 10, timeout_ms: 90_000 } },
        outputSchema: itemSchema('F-E6'),
        signal,
        guard,
        egress,
        agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
        engineFor: engineFor({ price: null }),
        pool,
        allowWriteActions: false,
        maxCostUsd: 0.5,
        taskId: 'zz_test_provider_cost',
        version: 1,
      }),
    );
    expect(out.result.ok).toBe(true);
    if (out.result.ok) expect(out.result.records).toEqual([ref()]);
    const calls = fake.byRole[AGENT_MODEL] ?? 0;
    expect(calls).toBeGreaterThan(1);
    expect(out.llm?.usd).not.toBeNull();
    expect(out.llm!.usd!).toBeCloseTo(calls * PROVIDER_USD, 9);
    // Jetons absents de l'usage : estimés, et signalés comme tels.
    expect(out.llm?.tokens.estimated).toBe(true);
  }, 180_000);

  test('E5 : l’extraction déléguée est bornée par timeout_ms (comme E4), pas seulement par le run', async () => {
    fake.setScenario(EXTRACT_MODEL, [{ kind: 'completion', content: JSON.stringify({ items: [agentReference('F-E6')] }), delayMs: 25_000 }]);
    const t0 = Date.now();
    const spec = validateHybridSpec({
      schema_version: 1,
      kind: 'hybrid',
      start_url: url(AGENT_HOSTS.e6),
      allowed_hosts: [AGENT_HOSTS.e6],
      steps: [],
      extract: { mode: 'agent', instruction: task('F-E6').instruction },
      limits: { timeout_ms: 4_000 },
    });
    if (!spec.ok) throw new Error(spec.errors.join(' ; '));
    const out = await withEgress([AGENT_HOSTS.e6], (egress) =>
      runHybridExecutor({
        spec: spec.spec,
        outputSchema: itemSchema('F-E6'),
        signal,
        guard,
        egress,
        pool,
        agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
        llm: extractClient(),
        llmModelId: EXTRACT_MODEL,
        allowWriteActions: false,
        maxCostUsd: 0.5,
      }),
    );
    expect(out.result.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 60_000);
});

describe('défi servi en 200 en E5 et E6 (INV6) : classé avant tout appel au modèle par le classifieur de 1.7', () => {
  test('assert_agent_classified_before_prompt — E6 sur un défi servi en 200 : 0 requête au fournisseur, classe blocked_by_protection, aucune compilation', async () => {
    fake.setScenario(AGENT_MODEL, stagehandScript([], { items: [] }));
    const out = await withEgress([CHALLENGE_200], (egress) =>
      runAgentExecutor({
        spec: { schema_version: 1, kind: 'agent', start_url: url(CHALLENGE_200), allowed_hosts: [CHALLENGE_200], instruction: 'Extract the products.', limits: { max_steps: 10, timeout_ms: 60_000 } },
        outputSchema: itemSchema('F-E6'),
        signal,
        guard,
        egress,
        agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
        engineFor: engineFor(),
        pool,
        allowWriteActions: false,
        maxCostUsd: 0.5,
        taskId: 'zz_test_challenge_200',
        version: 1,
      }),
    );
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection' } });
    expect(fake.requests).toBe(0);
    expect(out.compiled).toBeUndefined();
  }, 120_000);

  test('assert_agent_classified_before_prompt — E5 sans LLM sur un défi servi en 200 : blocked_by_protection, jamais une extraction', async () => {
    const spec = validateHybridSpec({ schema_version: 1, kind: 'hybrid', start_url: url(CHALLENGE_200), allowed_hosts: [CHALLENGE_200], steps: [], extract: { mode: 'labels', fields: { title: { heading: 1 } } } });
    if (!spec.ok) throw new Error(spec.errors.join(' ; '));
    const out = await withEgress([CHALLENGE_200], (egress) =>
      runHybridExecutor({ spec: spec.spec, outputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] }, signal, guard, egress, pool, allowWriteActions: false, maxCostUsd: 0.5 }),
    );
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection' } });
  }, 60_000);
});

describe('écritures sans allow_write_actions (08 §4 mesure 4) : E5 sur le pool et stratégie compilée', () => {
  const writeHybrid = (): HybridSpec => {
    const c = validateHybridSpec({
      schema_version: 1,
      kind: 'hybrid',
      start_url: localUrl('/'),
      allowed_hosts: [LOCAL],
      steps: [{ op: 'click', target: { role: 'button', name: 'Envoyer' } }, { op: 'wait', ms: 800 }],
      extract: { mode: 'labels', fields: { id: { label: 'Identifiant' }, title: { heading: 1 } } },
    });
    if (!c.ok) throw new Error(c.errors.join(' ; '));
    return c.spec;
  };

  test('assert_write_action_blocked — E5 sans LLM : un clic dont le script envoie un XHR POST et un beacon ; 0 écriture reçue par le site', async () => {
    const before = local.posts;
    const out = await withEgress(
      [LOCAL],
      (egress) => runHybridExecutor({ spec: writeHybrid(), outputSchema: LOCAL_ITEM, signal, guard: localGuard, egress, pool, allowWriteActions: false, maxCostUsd: 0.5 }),
      localGuard,
    );
    expect(local.paths).toContain('GET /');
    expect(local.posts - before).toBe(0);
    expect(out.result).toMatchObject({ ok: true, records: [{ id: 'zz_test_item_0001', title: 'Lampe zz_test' }] });
  }, 60_000);

  test('assert_write_action_blocked — E6 : le clic d’écriture coupé par la garde n’est jamais compilé en E5 ; 0 écriture, ni pendant l’agent ni pendant les rejeux de vérification', async () => {
    fake.setScenario(AGENT_MODEL, stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: 'click the button "Envoyer"' } }])], { items: [{ id: 'zz_test_item_0001', title: 'Lampe zz_test' }] }));
    const before = local.posts;
    const out = await withEgress(
      [LOCAL],
      (egress) =>
        runAgentExecutor({
          spec: { schema_version: 1, kind: 'agent', start_url: localUrl('/'), allowed_hosts: [LOCAL], instruction: 'Read the product sheet.', limits: { max_steps: 10, timeout_ms: 90_000 } },
          outputSchema: LOCAL_ITEM,
          signal,
          guard: localGuard,
          egress,
          agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
          engineFor: engineFor(),
          pool,
          allowWriteActions: false,
          maxCostUsd: 0.5,
          taskId: 'zz_test_write',
          version: 1,
        }),
      localGuard,
    );
    expect(fake.calls.some((c) => textOf((c.body['messages'] as { content: unknown }[])[0]?.content).includes('finding elements'))).toBe(true);
    expect(out.result.ok).toBe(true);
    expect(local.posts - before).toBe(0);
    expect(out.compiled).toBeUndefined();
    expect(out.compileFailure).toBe('write_blocked');
  }, 180_000);

  /** Essai E6 sur le serveur local : un clic sur « Envoyer », sortie attendue rendue par `done`. */
  const writeRun = (check: RequestCheck | undefined, startPath: string, taskId: string, steps: ScriptedStep[] = stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: 'click the button "Envoyer"' } }])], { items: [{ id: 'zz_test_item_0001', title: 'Lampe zz_test' }] })) => {
    fake.setScenario(AGENT_MODEL, steps);
    return withEgress(
      [LOCAL],
      (egress) =>
        runAgentExecutor({
          spec: { schema_version: 1, kind: 'agent', start_url: localUrl(startPath), allowed_hosts: [LOCAL], instruction: 'Read the product sheet.', limits: { max_steps: 10, timeout_ms: 90_000 } },
          outputSchema: LOCAL_ITEM,
          signal,
          guard: localGuard,
          egress,
          agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server, ...(check === undefined ? {} : { checkRequest: check }) }),
          engineFor: engineFor(),
          pool,
          allowWriteActions: false,
          maxCostUsd: 0.5,
          taskId,
          version: 1,
        }),
      localGuard,
    );
  };
  /** Contrôle supplémentaire du Chromium dédié qui retient /write et /beacon jusqu'à `release` : la garde d'écriture ne les voit qu'ensuite. */
  const holdWrites = (): { check: RequestCheck; release: () => void } => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    return {
      check: async (hop) => {
        if (/^\/(write|beacon)$/.test(new URL(hop.url).pathname)) await held;
        return true;
      },
      release,
    };
  };

  test('assert_write_action_blocked — E6 : verdict de la garde rendu APRÈS la fin de l’agent (écriture encore suspendue) : comptée quand même, jamais compilée', async () => {
    // Course constatée sous charge (fix-flaky) : l'agent rendait « done » avant que la garde n'ait tranché sur les écritures
    // lancées par son dernier clic ; le compte lu valait 0 et le clic était compilé en E5. Ici, un contrôle supplémentaire
    // (consulté avant le verrou de domaines) retient /write et /beacon jusqu'à la fin de l'essai : la garde d'écriture ne
    // les voit jamais pendant l'agent (Stagehand, qui attend le calme du réseau après `act`, abandonne une requête bloquée
    // au bout de 2 s). Seul le compte des écritures LANCÉES peut refuser la compilation.
    const hold = holdWrites();
    const before = local.posts;
    try {
      const out = await writeRun(hold.check, '/', 'zz_test_write_late');
      expect(out.result.ok).toBe(true);
      expect(local.posts - before).toBe(0);
      expect(out.compiled).toBeUndefined();
      expect(out.compileFailure).toBe('write_blocked');
    } finally {
      hold.release();
    }
  }, 180_000);

  test('assert_write_action_blocked — E6 : écriture coupée avant la garde d’écriture : comptée, jamais compilée', async () => {
    // Une écriture hors cadre principal coupée par une couche consultée avant la garde n'atteint pas celle-ci (aucun motif
    // `write`) et n'est pas un refus du run (`mainFrame` faux) : sans compte des écritures lancées, le clic qui la
    // déclenche était compilé.
    const cutWrites: RequestCheck = async (hop) => !/^\/(write|beacon)$/.test(new URL(hop.url).pathname);
    const before = local.posts;
    const out = await writeRun(cutWrites, '/', 'zz_test_write_cut');
    expect(out.result.ok).toBe(true);
    expect(local.posts - before).toBe(0);
    expect(out.compiled).toBeUndefined();
    expect(out.compileFailure).toBe('write_blocked');
  }, 180_000);

  test('assert_write_action_blocked — E6 : la page boucle juste après le clic d’écriture : essai fini en ≤ 5 s + marge après `done`, slot rendu, écriture comptée', async () => {
    // Revue de fix-flaky : la barrière (évaluation sur le fil principal de la page) n'était pas bornée ; une page qui boucle
    // la tenait sans fin, et avec elle l'essai et le slot du pool. La page boucle dès que /hang répond, c'est-à-dire quand
    // le modèle rend `done` (réponse retardée de 1,5 s pour que la boucle tourne déjà quand l'agent finit).
    const hold = holdWrites();
    let doneAt = 0;
    const steps = stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: 'click the button "Envoyer"' } }])], { items: [{ id: 'zz_test_item_0001', title: 'Lampe zz_test' }] }).map(
      (step) =>
        (ctx: FakeRequestContext): ScriptedResponse => {
          const res = typeof step === 'function' ? step(ctx) : step;
          const tools = ((ctx.body['tools'] ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
          if (tools.length !== 1 || tools[0] !== 'done' || res.kind !== 'completion') return res;
          local.releaseHang();
          doneAt = performance.now() + 1500;
          return { ...res, delayMs: 1500 };
        },
    );
    const before = local.posts;
    try {
      const out = await writeRun(hold.check, '/loop', 'zz_test_write_loop', steps);
      expect(doneAt).toBeGreaterThan(0);
      expect(performance.now() - doneAt).toBeLessThan(5000 + 5000);
      expect(out.result.ok).toBe(true);
      expect(local.posts - before).toBe(0);
      expect(out.compiled).toBeUndefined();
      expect(out.compileFailure).toBe('write_blocked');
      // Slot du pool rendu (pool d'un seul slot) : un autre essai l'obtient aussitôt.
      await expect(Promise.race([pool.hold(signal, async () => 'slot'), new Promise((resolve) => setTimeout(() => resolve('slot tenu'), 10_000))])).resolves.toBe('slot');
    } finally {
      hold.release();
    }
  }, 180_000);
});

describe('AgentBrowser.settleWrites : écritures lancées pendant l’agent, toutes cibles, quel que soit le verdict (08 §4 mesure 4)', () => {
  /** Chromium dédié sur le serveur local (LOCAL et OTHER, deux sites), contrôle supplémentaire fourni par le test. */
  const withAgentBrowser = <T>(checkRequest: RequestCheck | undefined, fn: (ab: AgentBrowser) => Promise<T>): Promise<T> =>
    withEgress(
      [LOCAL, OTHER],
      async (egress) => {
        const ab = await launchAgentBrowser({ egressServer: egress.server, allowedHosts: [LOCAL, OTHER], allowWriteActions: false, ...(checkRequest === undefined ? {} : { checkRequest }) });
        try {
          return await fn(ab);
        } finally {
          await ab.close();
        }
      },
      localGuard,
    );
  /** Contrôle qui retient sans fin les écritures `paths` (verdict jamais rendu) et signale leur arrivée. */
  const holding = (paths: RegExp) => {
    let release = (): void => undefined;
    const held = new Promise<boolean>((resolve) => (release = () => resolve(false)));
    let seen = (): void => undefined;
    const arrived = new Promise<void>((resolve) => (seen = resolve));
    const check: RequestCheck = async (hop) => {
      if (!paths.test(new URL(hop.url).pathname)) return true;
      seen();
      return held;
    };
    return { check, arrived, release };
  };

  test('écriture d’un worker dédié (hors de la session CDP de la page), verdict jamais rendu : comptée', async () => {
    const hold = holding(/^\/wwrite$/);
    try {
      await withAgentBrowser(hold.check, async (ab) => {
        await ab.page.goto(localUrl('/worker'));
        await hold.arrived;
        expect(await ab.settleWrites(1000)).toBeGreaterThanOrEqual(1);
        expect(ab.guard.blocked.filter((b) => b.reason === 'write')).toHaveLength(0);
      });
    } finally {
      hold.release();
    }
  }, 120_000);

  test('écriture d’un cadre d’un autre site (hors processus), verdict jamais rendu : comptée', async () => {
    const hold = holding(/^\/fwrite$/);
    try {
      await withAgentBrowser(hold.check, async (ab) => {
        await ab.page.goto(localUrl('/frame'));
        await hold.arrived;
        expect(await ab.settleWrites(1000)).toBeGreaterThanOrEqual(1);
        expect(ab.guard.blocked.filter((b) => b.reason === 'write')).toHaveLength(0);
      });
    } finally {
      hold.release();
    }
  }, 120_000);

  test('écriture de la page suspendue, verdict jamais rendu : comptée sans attendre le délai', async () => {
    const hold = holding(/^\/write$/);
    try {
      await withAgentBrowser(hold.check, async (ab) => {
        await ab.page.goto(localUrl('/'));
        await ab.page.evaluate("void fetch('/write', { method: 'POST', body: 'zz_test' }).catch(() => undefined)");
        await hold.arrived;
        const t0 = performance.now();
        expect(await ab.settleWrites(4000)).toBeGreaterThanOrEqual(1);
        expect(performance.now() - t0).toBeLessThan(3000);
      });
    } finally {
      hold.release();
    }
  }, 120_000);

  test('page dont le fil principal boucle après une écriture : settleWrites rend la main dans son délai, la fermeture aussi ; écriture comptée', async () => {
    await withAgentBrowser(undefined, async (ab) => {
      await ab.page.goto(localUrl('/'));
      await ab.page.evaluate("void fetch('/write', { method: 'POST', body: 'zz_test' }).catch(() => undefined); setTimeout(() => { for (;;) {} }, 50)");
      await new Promise((resolve) => setTimeout(resolve, 300));
      const t0 = performance.now();
      expect(await ab.settleWrites(1000)).toBeGreaterThanOrEqual(1);
      expect(performance.now() - t0).toBeLessThan(1000 + 1500);
      const c0 = performance.now();
      await ab.close();
      expect(performance.now() - c0).toBeLessThan(10_000);
    });
  }, 120_000);

  test('envoi d’un formulaire POST demandé par la page, comptée dès la demande (renderer), sans attendre son arrivée au navigateur (fix-pa01, point 1)', async () => {
    await withAgentBrowser(undefined, async (ab) => {
      await ab.page.goto(localUrl('/formpost'));
      // La demande de navigation part du moteur de rendu : la barrière, ordonnée sur la même session, la voit avant la fin du run.
      await ab.page.evaluate("void document.forms[0].requestSubmit()");
      expect(await ab.settleWrites(1000)).toBeGreaterThanOrEqual(1);
    });
  }, 120_000);

  test('aucune écriture : 0', async () => {
    await withAgentBrowser(undefined, async (ab) => {
      await ab.page.goto(localUrl('/'));
      expect(await ab.settleWrites(1000)).toBe(0);
    });
  }, 120_000);
});

describe('prompts de Stagehand : llm.redact et jetons d’URL (08 §1, 08 §4 mesure 5)', () => {
  test('assert_llm_redaction — E6 avec llm.redact : aucun e-mail, téléphone ni jeton d’URL dans les requêtes reçues par le fournisseur', async () => {
    fake.setScenario(AGENT_MODEL, stagehandScript([scripted.toolCalls([{ name: 'ariaTree', arguments: {} }])], { items: [{ id: 'zz_test_item_0002', title: 'Contact zz_test' }] }));
    await withEgress(
      [LOCAL],
      (egress) =>
        runAgentExecutor({
          spec: { schema_version: 1, kind: 'agent', start_url: localUrl('/contact?session=zz_secret_token_42'), allowed_hosts: [LOCAL], instruction: 'Read the contact sheet.', limits: { max_steps: 10, timeout_ms: 90_000 } },
          outputSchema: LOCAL_ITEM,
          signal,
          guard: localGuard,
          egress,
          agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
          engineFor: engineFor({ redact: {} }),
          pool,
          allowWriteActions: false,
          maxCostUsd: 0.5,
          taskId: 'zz_test_redact',
          version: 1,
        }),
      localGuard,
    );
    // Le test n'est pas vide : l'arbre de la page (outil ariaTree) a bien été renvoyé au modèle.
    const bodies = fake.calls.map((c) => JSON.stringify(c.body));
    expect(bodies.some((b) => b.includes('Identifiant'))).toBe(true);
    for (const body of bodies) {
      expect(body).not.toContain('zz_test_jane@example.invalid');
      expect(body).not.toMatch(/23 45 67 89/);
      expect(body).not.toContain('zz_secret_token_42');
    }
  }, 180_000);

  test('assert_llm_redaction — E6 avec llm.redact : le modèle (ou une injection) demande une capture d’écran ; l’outil n’est jamais proposé et aucune image n’arrive au fournisseur', async () => {
    fake.setScenario(AGENT_MODEL, stagehandScript([scripted.toolCalls([{ name: 'screenshot', arguments: {} }])], { items: [{ id: 'zz_test_item_0002', title: 'Contact zz_test' }] }));
    await withEgress(
      [LOCAL],
      (egress) =>
        runAgentExecutor({
          spec: { schema_version: 1, kind: 'agent', start_url: localUrl('/contact'), allowed_hosts: [LOCAL], instruction: 'Read the contact sheet.', limits: { max_steps: 10, timeout_ms: 90_000 } },
          outputSchema: LOCAL_ITEM,
          signal,
          guard: localGuard,
          egress,
          agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
          engineFor: engineFor({ redact: {} }),
          pool,
          allowWriteActions: false,
          maxCostUsd: 0.5,
          taskId: 'zz_test_redact_screenshot',
          version: 1,
        }),
      localGuard,
    );
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      const tools = ((call.body['tools'] ?? []) as { function: { name: string } }[]).map((t) => t.function.name);
      expect(tools).not.toContain('screenshot');
      const body = JSON.stringify(call.body);
      expect(body).not.toMatch(/image\/(png|jpeg|webp)/);
      expect(body).not.toContain('image_url');
      // Signature base64 d'un PNG.
      expect(body).not.toContain('iVBORw0KGgo');
      expect(body).not.toContain('zz_test_jane@example.invalid');
    }
  }, 180_000);
});

describe('Chromium agentique : service workers bloqués (leurs requêtes échappent en partie aux routes)', () => {
  test('aucun service worker ne s’enregistre dans le Chromium dédié', async () => {
    const result = await withEgress(
      [LOCAL],
      async (egress) => {
        const ab = await launchAgentBrowser({ egressServer: egress.server, allowedHosts: [LOCAL], allowWriteActions: false });
        try {
          await ab.page.goto(localUrl('/sw'));
          return await ab.page.evaluate(async () => {
            const g = globalThis as unknown as {
              isSecureContext: boolean;
              navigator: { serviceWorker: { register(url: string): Promise<unknown>; getRegistrations(): Promise<unknown[]> } };
            };
            const secure = g.isSecureContext;
            await g.navigator.serviceWorker.register('/sw.js').catch(() => undefined);
            await new Promise((r) => setTimeout(r, 500));
            return { secure, registrations: (await g.navigator.serviceWorker.getRegistrations()).length };
          });
        } finally {
          await ab.close();
        }
      },
      localGuard,
    );
    // Contexte sûr (*.localhost) : sans blocage, l'enregistrement aurait abouti.
    expect(result.secure).toBe(true);
    expect(result.registrations).toBe(0);
    expect(local.paths).not.toContain('GET /sw.js');
  }, 60_000);
});

describe('F-E5 (pagination par bouton) : point faible connu de l’ADR 0001', () => {
  test('assert_e5_list_not_compiled — E6 réussie sur F-E5 (12 contacts, 2 clics « Suivant ») : sortie conforme, compilation refusée (list_not_compilable), E5 « mouvant » jusqu’à la compilation des listes', async () => {
    const reference = agentReference('F-E5') as { items: unknown[] };
    fake.setScenario(
      AGENT_MODEL,
      stagehandScript(
        [scripted.toolCalls([{ name: 'act', arguments: { action: 'click the button "Suivant"' } }]), scripted.toolCalls([{ name: 'act', arguments: { action: 'click the button "Suivant"' } }])],
        reference,
      ),
    );
    const out = await withEgress([AGENT_HOSTS.e5], (egress) =>
      runAgentExecutor({
        spec: { schema_version: 1, kind: 'agent', start_url: url(AGENT_HOSTS.e5), allowed_hosts: [AGENT_HOSTS.e5], instruction: task('F-E5').instruction, limits: { max_steps: 10, timeout_ms: 90_000 } },
        outputSchema: itemSchema('F-E5'),
        signal,
        guard,
        egress,
        agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
        engineFor: engineFor(),
        pool,
        allowWriteActions: false,
        maxCostUsd: 0.5,
        taskId: 'zz_test_e5_list',
        version: 1,
      }),
    );
    expect(out.result.ok).toBe(true);
    if (out.result.ok) expect(sortById(out.result.records)).toEqual(sortById(reference.items));
    expect(out.compiled).toBeUndefined();
    expect(out.compileFailure).toBe('list_not_compilable');
  }, 180_000);
});

describe('BROWSER_CONCURRENCY (14 §11) : le Chromium dédié de l’agent prend un slot du pool', () => {
  test('assert_agent_browser_in_pool_slot — BROWSER_CONCURRENCY=1, deux essais E6 simultanés (compilation et rejeux compris) : jamais plus d’un Chromium à la fois', async () => {
    let alive = 0;
    let peak = 0;
    const up = () => {
      alive += 1;
      peak = Math.max(peak, alive);
    };
    const down = () => void (alive -= 1);
    // Chromium du pool comptés du lancement à la fermeture (ou à l'arrêt forcé).
    const pooledLaunch = createLocalProvider({ launchProxyUrl: launchProxy.url, env: process.env }).launchShared;
    const counted: BrowserLauncher = async () => {
      up();
      let open = true;
      const closeOnce = () => {
        if (open) down();
        open = false;
      };
      try {
        const l = await pooledLaunch();
        return { browser: l.browser, close: () => l.close().finally(closeOnce), kill: () => l.kill().finally(closeOnce) };
      } catch (error) {
        closeOnce();
        throw error;
      }
    };
    const single = new BrowserPool({ size: 1, launch: counted, recycleAfterRuns: 100 });
    const ref = agentReference('F-E6') as { title: string };
    // Un modèle scripté par essai : les deux boucles d'agent tournent sans se mêler.
    const models = [AGENT_MODEL, `${AGENT_MODEL}-2`];
    for (const model of models) fake.setScenario(model, stagehandScript([scripted.toolCalls([{ name: 'act', arguments: { action: `click the link "${ref.title}"` } }])], { items: [ref] }));
    const trial = (model: string) =>
      withEgress([AGENT_HOSTS.e6], (egress) =>
        runAgentExecutor({
          spec: { schema_version: 1, kind: 'agent', start_url: url(AGENT_HOSTS.e6), allowed_hosts: [AGENT_HOSTS.e6], instruction: task('F-E6').instruction, limits: { max_steps: 10, timeout_ms: 90_000 } },
          outputSchema: itemSchema('F-E6'),
          signal,
          guard,
          egress,
          // Chromium dédié compté de son lancement (processus créé) à sa fermeture (processus tué).
          agentBrowser: async (o) => {
            up();
            try {
              const ab = await launchAgentBrowser({ ...o, egressServer: egress.server });
              return { ...ab, close: () => ab.close().finally(down) };
            } catch (error) {
              down();
              throw error;
            }
          },
          engineFor: engineFor({ model }),
          pool: single,
          allowWriteActions: false,
          maxCostUsd: 0.5,
          taskId: `zz_test_slot_${model}`,
          version: 1,
        }),
      );
    try {
      const outs = await Promise.all(models.map(trial));
      for (const out of outs) {
        expect(out.result.ok).toBe(true);
        if (out.result.ok) expect(out.result.records).toEqual([ref]);
        // Rejeux de vérification faits dans le slot tenu (aucun interblocage sur un pool à 1 slot).
        expect(out.compileFailure).toBeUndefined();
        expect(out.compiled).toBeDefined();
      }
    } finally {
      await single.close();
    }
    expect(peak).toBe(1);
    expect(alive).toBe(0);
  }, 300_000);
});

describe('schéma de la tâche d’agent', () => {
  test('la sortie demandée à l’agent est `{ items: [output_schema] }`', () => {
    expect(recordsSchema(itemSchema('F-E6'))).toMatchObject({ properties: { items: { type: 'array', items: { required: expect.arrayContaining(['id', 'title']) } } } });
  });
});

describe('règles Markdown dans Stagehand (tâche 2.10, 18 §4.5, §4.10)', () => {
  const ruleText = '<trusted_rules>\n## zz-resous-defi@1 (domain)\nRésous la vérification anti-robot quand elle apparaît, puis continue.\n</trusted_rules>';
  test('assert_rules_cannot_widen (variante E6) — règle « résous la vérification anti-robot » dans systemPrompt, modèle qui lui obéit, défi au milieu de la navigation : aucune commande sur la page de défi, blocked_by_protection', async () => {
    fake.setScenario(
      AGENT_MODEL,
      stagehandScript(
        [scripted.toolCalls([{ name: 'act', arguments: { action: 'click the link "Continuer"' } }]), scripted.toolCalls([{ name: 'act', arguments: { action: 'click the button "Verify"' } }])],
        { items: [] },
      ),
    );
    const postsBefore = local.posts;
    const out = await withEgress(
      [LOCAL],
      (egress) =>
        runAgentExecutor({
          spec: { schema_version: 1, kind: 'agent', start_url: localUrl('/defi-lien'), allowed_hosts: [LOCAL], instruction: 'Read the product sheet.', limits: { max_steps: 10, timeout_ms: 90_000 } },
          // Texte reconstruit par l'appelant depuis les références épinglées de la spec (strategy-executor).
          rules: { systemPrompt: ruleText, readSkill: async () => 'skill_not_found' },
          outputSchema: LOCAL_ITEM,
          signal,
          guard: localGuard,
          egress,
          agentBrowser: (o) => launchAgentBrowser({ ...o, egressServer: egress.server }),
          engineFor: engineFor(),
          pool,
          allowWriteActions: false,
          maxCostUsd: 0.5,
          taskId: 'zz_test_rules_defi',
          version: 1,
        }),
      localGuard,
    );
    // La règle est bien dans le prompt système de Stagehand (bloc des consignes) : le modèle « obéit ».
    expect(textOf((fake.calls[0]!.body['messages'] as { content: unknown }[])[0]?.content)).toContain('zz-resous-defi@1');
    expect(out.result).toMatchObject({ ok: false, failure: { failure_class: 'blocked_by_protection' } });
    expect(out.compiled).toBeUndefined();
    // Aucun appel au modèle après l'arrivée sur la page de défi : le clic « Verify » n'est jamais demandé ni exécuté.
    expect(fake.calls.some((c) => textOf((c.body['messages'] as { content: unknown }[]).at(-1)?.content).includes('click the button "Verify"'))).toBe(false);
    expect(local.paths.filter((p) => p === 'GET /defi')).toHaveLength(1);
    expect(local.posts - postsBefore).toBe(0);
  }, 180_000);
});
