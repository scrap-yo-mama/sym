// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur de production du worker (tâche 1.6) : garde SSRF de l'environnement (ALLOWED_PRIVATE_HOSTS,
// ALLOWED_EGRESS_PORTS), cadence par domaine en base (1.9), dépôt de secrets (identifiants des proxys BYO), pool
// Chromium de `BROWSER_CONCURRENCY` slots derrière un proxy de lancement FERMÉ (aucun trafic hors contexte de run),
// recyclage au seuil mémoire du cgroup (mémoire de travail, page cache inactif exclu, au-delà de 90 % de la limite).
// Bac à sable des scripts E3 (1.5) : utilisateur dédié lu dans l'environnement (SANDBOX_UID, SANDBOX_GID,
// SANDBOX_LAUNCHER) ; en production, la frontière de l'OS est éprouvée au démarrage (`probeIsolation`) et le worker
// refuse de démarrer si l'enfant pourrait lire l'environnement du worker (D-30).
import { DomainPacer, type SandboxEngine } from '@runtime/core';
import { SsrfGuard, ssrfPolicyFromEnv, startEgressProxy, type EgressProxy } from '@runtime/core/net';
import { STAGEHAND_VERSION, StagehandEngine } from '@runtime/agent';
import { resolveIdentifyInstance, resolveInstanceContact, RobotsCache } from '@runtime/core/access';
import { PgPacingStore, readIdentifyInstanceSetting, readInstanceContactSetting, readLlmSettings, secretStore } from '@runtime/db';
import { createLlmClient, llmConfigFromSettings, roleProblems, roleTarget, type LlmConfig } from '@runtime/llm';
import { launchAgentBrowser } from '../browser/agent-browser.js';
import { cgroupMemoryLimitBytes, cgroupMemoryWorkingSetBytes } from '../browser/cgroup.js';
import { BrowserPool, playwrightLauncher } from '../browser/pool.js';
import { ProcessSandboxEngine, sandboxOptionsFromEnv, type IsolationProbe } from '../sandbox/index.js';
import type { ExecutorFactory } from '../worker.js';
import { loadInlineScript } from './script-executor.js';
import { TunnelJobClient } from '../tunnel/client.js';
import type { EngineFactory } from './agent-executors.js';
import { createStrategyExecutor, type AgentPorts } from './strategy-executor.js';

/** Version du prompt du moteur : celui de Stagehand, non modifié (mesuré tel quel au spike 0.6a). */
const STAGEHAND_PROMPT_VERSION = `stagehand-${STAGEHAND_VERSION}-dom`;

/**
 * Moteur du rôle `agent` (ADR 0001) : Stagehand 3.7.3 en local sur le Chromium dédié de l'essai. Il appelle le
 * fournisseur hors du LlmClient : `llm.redact` des réglages lui est donc passé (masquage dans son middleware, 08 §1),
 * avec les points d'accroche de l'essai (plafond de coût partagé, garde de classification). Un modèle sans prix reste
 * permis (08 §1 : coût null avec avertissement) ; le plafond étant alors intenable, le run s'arrête après le premier appel.
 */
export function stagehandEngineFor(config: LlmConfig, env: NodeJS.ProcessEnv = process.env): EngineFactory {
  return ({ cdpUrl, recorder, hooks }) => {
    const target = roleTarget(config, 'agent');
    if (target === undefined) return null;
    // Même règle que le client LLM (08 §1) : le rôle agent exige un profil sondé avec appel d'outils.
    const profile = 'profile' in target.model ? target.model.profile : undefined;
    if (roleProblems('agent', profile).length > 0) return null;
    const price = 'price' in target.model ? target.model.price : undefined;
    return {
      engine: new StagehandEngine({
        cdpUrl,
        baseURL: target.provider.baseUrl,
        apiKey: () => target.provider.apiKey.reveal(),
        price,
        recorder,
        env,
        ...(config.redact === undefined ? {} : { redact: config.redact }),
        ...hooks,
      }),
      modelId: target.model.id,
      promptVersion: STAGEHAND_PROMPT_VERSION,
    };
  };
}

class SandboxIsolationError extends Error {
  override name = 'SandboxIsolationError';
}

/** Part de la limite mémoire du cgroup au-delà de laquelle un Chromium est recyclé à la fin de son run. */
const BROWSER_MEMORY_RECYCLE_RATIO = 0.9;

/** Moteur du bac à sable tel que le voit la fabrique : exécution des scripts E3 et sonde d'isolation au démarrage. */
type FactoryEngine = SandboxEngine & { probeIsolation(): Promise<IsolationProbe> };

export type ProductionFactoryOverrides = {
  /** Moteur du bac à sable (tests) ; défaut : `ProcessSandboxEngine` sur l'utilisateur dédié lu dans l'environnement. */
  readonly sandboxEngine?: (options: { production: boolean }) => FactoryEngine;
};

export function productionExecutorFactory(env: Readonly<Record<string, string | undefined>> = process.env, overrides: ProductionFactoryOverrides = {}): ExecutorFactory {
  return async ({ pool, config, checked, logger }) => {
    const guard = new SsrfGuard({ policy: ssrfPolicyFromEnv(env) });
    const pacer = new DomainPacer(new PgPacingStore(pool));
    const secrets = secretStore(pool, config.keyring, checked);
    const production = env['NODE_ENV'] === 'production';
    const engine: FactoryEngine = overrides.sandboxEngine?.({ production }) ?? new ProcessSandboxEngine({ ...sandboxOptionsFromEnv(env), production });
    if (production) {
      const probe = await engine.probeIsolation();
      if (probe.parentEnviron === 'readable') {
        throw new SandboxIsolationError("bac à sable : l'enfant lit l'environnement du worker (utilisateur dédié requis, D-30)");
      }
      logger.info({ sandboxUid: probe.uid, noNewPrivs: probe.noNewPrivs }, 'bac à sable : isolation éprouvée');
    }
    let browsers: BrowserPool | null = null;
    let launchProxy: EgressProxy | undefined;
    if (!config.disableBrowser) {
      launchProxy = await startEgressProxy({
        guard,
        refuseAll: true,
        onRequest: (target) => logger.warn({ host: target.host, port: target.port }, 'Chromium : trafic hors contexte de run refusé'),
      });
      const limit = cgroupMemoryLimitBytes();
      browsers = new BrowserPool({
        size: config.browserConcurrency,
        launch: playwrightLauncher(launchProxy.url, env),
        ...(limit === undefined ? {} : { memoryHigh: () => (cgroupMemoryWorkingSetBytes() ?? 0) > limit * BROWSER_MEMORY_RECYCLE_RATIO }),
        onEvent: (event) => logger.info(event, 'navigateur'),
      });
      logger.info({ browserConcurrency: config.browserConcurrency, source: config.browserConcurrencySource }, 'pool Chromium prêt (lancement à la demande)');
    }
    const pool_ = browsers;
    // E4-E6 (tâche 2.4) : réglages LLM relus à chaque essai, clés dans le dépôt de secrets (INV8).
    const agent: AgentPorts = {
      llmConfig: async () => {
        const value = await readLlmSettings(pool);
        return value === null ? null : llmConfigFromSettings(value, (id) => secrets.get(id), ['extract', 'agent']);
      },
      client: (config) => createLlmClient(config),
      engineFor: (config) => stagehandEngineFor(config, env as NodeJS.ProcessEnv),
      // Lancé par les exécuteurs E5 et E6 DANS un slot du pool (BrowserPool.hold) : BROWSER_CONCURRENCY le borne (14 §11).
      agentBrowser: (options) => launchAgentBrowser({ ...options, env }),
    };
    // Mode tunnel (2.7) : commandes par `tunnel_jobs`, réponses réveillées par LISTEN sur la connexion de session.
    const tunnel = new TunnelJobClient({ pool, sessionUrl: config.databaseUrlDirect ?? config.databaseUrl, logger });
    await tunnel.start();
    // Module d'accès (1.11) : un cache de robots.txt pour le worker (24 h au plus), contact de l'instance relu à chaque run
    // (réglage de l'assistant, puis INSTANCE_CONTACT), identification de l'instance relue aussi (réglage `identify_instance`,
    // puis IDENTIFY_INSTANCE, désactivée par défaut), version annoncée dans le jeton du User-Agent.
    const robotsCache = new RobotsCache();
    const instanceContact = async (): Promise<string | null> => resolveInstanceContact(await readInstanceContactSetting(pool), env);
    const identifyInstance = async (): Promise<boolean> => resolveIdentifyInstance(await readIdentifyInstanceSetting(pool), env);
    return {
      executor: createStrategyExecutor({ pool, guard, pacer, browsers, secrets, logger, tunnel, script: { engine, loadScript: loadInlineScript }, agent, robotsCache, instanceContact, identifyInstance, version: config.version }),
      browserContexts: () => pool_?.active() ?? 0,
      close: async () => {
        await tunnel.close();
        await pool_?.close();
        await launchProxy?.close();
      },
    };
  };
}
