// SPDX-License-Identifier: AGPL-3.0-only
// Client `agent_step` du tunnel (07 §3, tâche 0.6b), de bout en bout sans navigateur ni extension : client serveur →
// fil JSON → exécuteur de l'extension (pilote factice) → fil JSON → client. Aucun LLM réel.
import { readFileSync } from 'node:fs';
import { Secret, AgentStepExecutor, type AgentEngine, type AgentStepAction, type AgentStepDriver, type AgentStepWireArgs, type AgentTask, type StepObservation } from '@runtime/core';
import { LlmClient, type CapabilityProfile } from '@runtime/llm';
import { createFakeProvider, scripted, type FakeProvider } from '@runtime/llm/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HomeLoopEngine } from './home-loop.js';
import {
  AgentStepProtocolError,
  AgentStepRefusedError,
  assertTunnelEngine,
  runAgentInTunnel,
  ThirdPartyEngineNotViaTunnelError,
  TunnelStepChannel,
  type AgentStepTransport,
} from './tunnel-channel.js';

const HOST = 'zz_test_agent_mobile_next.localhost';

/** Page factice de l'extension : liste de boutons, `ref` = rang courant, donc renumérotés quand la liste change. */
class FakeTab implements AgentStepDriver {
  items = ['Archiver', 'Supprimer tout', 'Suivant'];
  performed: string[] = [];
  challenge = false;
  async observe(): Promise<StepObservation> {
    return { url: `https://${HOST}/`, tree: this.items.map((name, i) => `- button "${name}" [ref=e${i + 1}]`).join('\n') };
  }
  async perform(action: AgentStepAction, expected?: { role: string; name: string }): ReturnType<AgentStepDriver['perform']> {
    if (action.kind === 'click') {
      const index = Number(action.target.ref.slice(1)) - 1;
      if (expected === undefined || this.items[index] !== expected.name) return { ok: false, error: 'stale_ref' };
      this.performed.push(`click:${expected.name}`);
      if (expected.name === 'Archiver') this.items.splice(index, 1);
    }
    return { ok: true };
  }
  classify(): 'read' | 'write' {
    return 'read';
  }
  challengeDetected(): boolean {
    return this.challenge;
  }
}

/** Onglet dont le pilote exécute tout sans vérifier `expected` : seule la règle snapshot_id + empreinte protège. */
class BlindTab extends FakeTab {
  override async perform(action: AgentStepAction): ReturnType<AgentStepDriver['perform']> {
    if (action.kind === 'click' || action.kind === 'type') {
      const name = this.items[Number(action.target.ref.slice(1)) - 1] ?? '?';
      this.performed.push(`${action.kind}:${name}`);
    }
    return { ok: true };
  }
}

/** Fil de test : tout passe par JSON, comme sur la WSS ; garde la liste des commandes émises. */
function loopback(tab: FakeTab): { transport: AgentStepTransport; sent: AgentStepWireArgs[]; executor: AgentStepExecutor } {
  const executor = new AgentStepExecutor({ driver: tab, urlAllowed: (url) => new URL(url).hostname === HOST, allowWriteActions: false });
  const sent: AgentStepWireArgs[] = [];
  return {
    executor,
    sent,
    transport: {
      async send(args) {
        sent.push(args);
        const response = await executor.execute(JSON.parse(JSON.stringify(args)));
        return JSON.parse(JSON.stringify(response)) as unknown;
      },
    },
  };
}

describe('assert_agent_step_stale_ref : client du tunnel', () => {
  it('un ref d\'un ancien snapshot_id renvoie stale_ref avec un nouvel instantané ; aucune action sur l\'élément qui a pris sa place', async () => {
    const tab = new FakeTab();
    const { transport } = loopback(tab);
    const channel = new TunnelStepChannel(transport);
    const first = await channel.snapshot();
    expect(first.snapshotId).toMatch(/^s\d+-[0-9a-f]{6}$/);
    expect(channel.semanticTarget(first.snapshotId, 'e2')).toEqual({ role: 'button', name: 'Supprimer tout' });
    const moved = await channel.execute({ kind: 'click', target: { snapshotId: first.snapshotId, ref: 'e1' } });
    expect(moved.ok).toBe(true);
    // « Supprimer tout » (e2 dans le premier instantané) est devenu e1 ; e2 désigne maintenant « Suivant ».
    const stale = await channel.execute({ kind: 'click', target: { snapshotId: first.snapshotId, ref: 'e2' } });
    expect(stale).toMatchObject({ ok: false, error: 'stale_ref' });
    expect(stale.snapshot?.snapshotId).not.toBe(first.snapshotId);
    expect(stale.snapshot?.accessibilityTree).toContain('button "Suivant" [ref=e2]');
    expect(tab.performed).toEqual(['click:Archiver']);
    // Avec l'instantané rendu par le refus, l'action part.
    const fresh = stale.snapshot!;
    expect((await channel.execute({ kind: 'click', target: { snapshotId: fresh.snapshotId, ref: 'e2' } })).ok).toBe(true);
    expect(tab.performed).toEqual(['click:Archiver', 'click:Suivant']);
  });

  it('pilote CDP qui ne vérifie rien : un ancien snapshot_id donne quand même stale_ref, et aucune action ne part', async () => {
    const tab = new BlindTab();
    const { transport } = loopback(tab);
    const channel = new TunnelStepChannel(transport);
    const first = await channel.snapshot();
    tab.items.shift();
    for (const action of [
      { kind: 'click', target: { snapshotId: first.snapshotId, ref: 'e1' } },
      { kind: 'type', target: { snapshotId: first.snapshotId, ref: 'e2' }, text: 'x' },
    ] as const) {
      const stale = await channel.execute(action);
      expect(stale).toMatchObject({ ok: false, error: 'stale_ref' });
      expect(stale.snapshot?.snapshotId).not.toBe(first.snapshotId);
    }
    expect(tab.performed).toEqual([]);
  });

  it('snapshot() refusé par l\'extension (défi, délai) : erreur typée qui garde le code, pas une erreur de protocole', async () => {
    const tab = new FakeTab();
    tab.challenge = true;
    const channel = new TunnelStepChannel(loopback(tab).transport);
    const error = await channel.snapshot().then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AgentStepRefusedError);
    expect(error).not.toBeInstanceOf(AgentStepProtocolError);
    expect(error).toMatchObject({ code: 'agent_step_refused', error: 'challenge_detected', action: 'read' });
    const late = new TunnelStepChannel({ send: async () => ({ ok: false, error: 'timeout', snapshot_id: null, snapshot: null }) });
    await expect(late.snapshot()).rejects.toMatchObject({ error: 'timeout' });
  });

  it('une réponse hors contrat (stale_ref sans instantané, succès sans instantané, charabia) est une erreur de protocole, jamais un succès', async () => {
    for (const raw of [
      { ok: false, error: 'stale_ref', snapshot_id: null, snapshot: null },
      { ok: true, error: null, snapshot_id: null, snapshot: null },
      'ok',
      null,
    ]) {
      const channel = new TunnelStepChannel({ send: async () => raw });
      await expect(channel.execute({ kind: 'read' })).rejects.toBeInstanceOf(AgentStepProtocolError);
    }
  });

  it('une commande qui sort du jeu fermé n\'est jamais émise par le client, et l\'extension la refuse si elle arrive', async () => {
    const tab = new FakeTab();
    const { transport, sent, executor } = loopback(tab);
    const channel = new TunnelStepChannel(transport);
    await channel.snapshot();
    expect(sent).toEqual([{ action: 'read' }]);
    const wire = await executor.execute({ action: 'evaluate', expression: 'document.cookie' });
    expect(wire).toMatchObject({ ok: false, error: 'method_not_allowed' });
  });

  it('défi : l\'extension arrête tout, le client ne renvoie plus aucune commande', async () => {
    const tab = new FakeTab();
    const { transport, sent } = loopback(tab);
    const channel = new TunnelStepChannel(transport);
    const first = await channel.snapshot();
    tab.challenge = true;
    expect(await channel.execute({ kind: 'scroll', snapshotId: first.snapshotId, direction: 'down' })).toMatchObject({ ok: false, error: 'challenge_detected' });
    const count = sent.length;
    expect(await channel.execute({ kind: 'read' })).toMatchObject({ ok: false, error: 'challenge_detected' });
    expect(sent).toHaveLength(count);
  });
});

const MODEL = 'zz_test_model';
const profile: CapabilityProfile = {
  model: MODEL, tools: true, tool_choice: ['auto'], structured_modes: [], structured: 'none', stream_tools: null, stream_usage: null,
  cache: false, reasoning_field: null, probed_at: 'zz_test', probe_tokens: 0, notes: [],
};
const task: AgentTask = {
  taskId: 'zz_test_task',
  instruction: 'Archive the first item then report the remaining ones.',
  startUrl: `https://${HOST}/`,
  allowedDomains: [HOST],
  outputSchema: { type: 'object', properties: { left: { type: 'number' } }, required: ['left'], additionalProperties: false },
  allowWriteActions: false,
  limits: { maxSteps: 6, maxDurationMs: 30_000, maxCostUsd: 0.5 },
};
const modelSettings = { modelId: MODEL, temperature: 0, promptVersion: 'v' } as const;

describe('assert_third_party_engine_not_via_tunnel', () => {
  let fake: FakeProvider;
  beforeAll(async () => {
    fake = await createFakeProvider();
  });
  afterAll(async () => {
    await fake.close();
  });

  const thirdParty = (): AgentEngine & { runs: number } => {
    const engine = {
      id: 'stagehand' as const,
      version: '3.7.3',
      capabilities: { agentStepCompatible: false },
      runs: 0,
      async run(): Promise<never> {
        engine.runs += 1;
        throw new Error('ne doit pas être appelé');
      },
    };
    return engine;
  };

  it('un moteur tiers (hors agent_step) est refusé en tunnel : aucun run, aucune commande émise', async () => {
    const engine = thirdParty();
    const sent: AgentStepWireArgs[] = [];
    const transport: AgentStepTransport = { send: async (args) => void sent.push(args) as never };
    expect(() => assertTunnelEngine(engine)).toThrow(ThirdPartyEngineNotViaTunnelError);
    await expect(runAgentInTunnel(engine, task, { transport, model: modelSettings })).rejects.toMatchObject({ code: 'third_party_engine_not_via_tunnel', engineId: 'stagehand' });
    expect(engine.runs).toBe(0);
    expect(sent).toEqual([]);
  });

  it('la boucle maison, qui ne parle qu\'au canal agent_step, traverse le tunnel : archive puis rend la sortie', async () => {
    fake.reset();
    fake.setScenario(MODEL, [scripted.text('observe')]);
    const tab = new FakeTab();
    const { transport } = loopback(tab);
    const llm = new LlmClient(
      { providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz_test_key'), models: [{ id: MODEL, price: { in: 1, out: 2 }, profile }] }], roles: { agent: { provider: 'fake', model: MODEL } } },
      { sleep: async () => undefined },
    );
    const engine = new HomeLoopEngine({ llm, version: 'zz_test' });
    expect(() => assertTunnelEngine(engine)).not.toThrow();
    // Le premier instantané de la page factice est `s1-<empreinte>` ; on le lit pour écrire le scénario.
    const probe = await new TunnelStepChannel(loopback(new FakeTab()).transport).snapshot();
    fake.setScenario(MODEL, [
      scripted.toolCalls([{ name: 'click', arguments: { snapshot_id: probe.snapshotId, ref: 'e1' } }]),
      scripted.toolCalls([{ name: 'done', arguments: { output: { left: 2 } } }]),
    ]);
    const result = await runAgentInTunnel(engine, task, { transport, model: modelSettings });
    expect(result.status).toBe('done');
    expect(result.output).toEqual({ left: 2 });
    expect(tab.performed).toEqual(['click:Archiver']);
    expect(result.steps[0]).toMatchObject({ action: 'click', semanticTarget: { role: 'button', name: 'Archiver' }, executed: true });
  });

  it('la boucle maison face à un défi dès le premier instantané : échec classé challenge_detected, pas engine_error', async () => {
    fake.reset();
    const tab = new FakeTab();
    tab.challenge = true;
    const llm = new LlmClient(
      { providers: [{ id: 'fake', baseUrl: fake.baseUrl, apiKey: new Secret('zz_test_key'), models: [{ id: MODEL, price: { in: 1, out: 2 }, profile }] }], roles: { agent: { provider: 'fake', model: MODEL } } },
      { sleep: async () => undefined },
    );
    const result = await runAgentInTunnel(new HomeLoopEngine({ llm, version: 'zz_test' }), task, { transport: loopback(tab).transport, model: modelSettings });
    expect(result).toMatchObject({ status: 'error', failureClass: 'challenge_detected', output: null });
    expect(tab.performed).toEqual([]);
  });

  it('un moteur qui ne déclare pas agentStepCompatible est refusé même s\'il se dit « home_loop » (la capacité décide, pas le nom)', () => {
    const liar = { ...thirdParty(), id: 'home_loop' as const };
    expect(() => assertTunnelEngine(liar)).toThrow(ThirdPartyEngineNotViaTunnelError);
  });

  it('seul le client du paquet parle au tunnel : le module ne touche ni Playwright, ni moteur tiers, ni réseau', () => {
    const source = readFileSync(new URL('./tunnel-channel.ts', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*') && !line.trimStart().startsWith('/**'))
      .join('\n');
    for (const forbidden of ['playwright', 'stagehand', 'browserbase', 'fetch(', 'WebSocket', 'node:net', 'node:http']) {
      expect(source.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });
});

