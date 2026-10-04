// SPDX-License-Identifier: AGPL-3.0-only
// Exécuteur de production du worker (tâche 1.6) : garde SSRF de l'environnement (ALLOWED_PRIVATE_HOSTS,
// ALLOWED_EGRESS_PORTS), cadence par domaine en base (1.9), dépôt de secrets (identifiants des proxys BYO), pool
// Chromium de `BROWSER_CONCURRENCY` slots derrière un proxy de lancement FERMÉ (aucun trafic hors contexte de run),
// recyclage au seuil mémoire du cgroup (mémoire de travail, page cache inactif exclu, au-delà de 90 % de la limite).
// Bac à sable des scripts E3 (1.5) : utilisateur dédié lu dans l'environnement (SANDBOX_UID, SANDBOX_GID,
// SANDBOX_LAUNCHER) ; en production, la frontière de l'OS est éprouvée au démarrage (`probeIsolation`) et le worker
// refuse de démarrer si l'enfant pourrait lire l'environnement du worker (D-30).
import { briefConfigFromEnv } from '@runtime/core';
import { costCapsFromEnv, DomainPacer, rejectionThresholdsFromEnv, type SandboxEngine } from '@runtime/core';
import { SsrfGuard, ssrfPolicyFromEnv, startEgressProxy, type EgressProxy } from '@runtime/core/net';
import { STAGEHAND_VERSION, StagehandEngine } from '@runtime/agent';
import { identityFromEnv, instanceContactEnvInvalid, resolveIdentifyInstance, resolveInstanceContact } from '@runtime/core/access';
import { PgPacingStore, publishBrowserProvider, publishRobotEngine, readIdentifyInstanceSetting, readInstanceContactSetting, readLlmSettings, scheduleRunJudge, secretStore } from '@runtime/db';
import { createLlmClient, llmConfigFromSettings, roleProblems, roleTarget, type LlmConfig, type LlmNote } from '@runtime/llm';
import { launchAgentBrowser } from '../browser/agent-browser.js';
import { CDP_ABSENT_CAPABILITIES } from '../browser/provider-cdp.js';
import { createLocalProvider } from '../browser/provider-local.js';
import type { RunEgress } from '../browser/run-egress.js';
import { detectProvider } from '../browser/provider-detect.js';
import type { BrowserProvider } from '@sym/contracts/browser';
import { installedEngineIdentity } from '../browser/engine-identity.js';
import { cgroupMemoryLimitBytes, cgroupMemoryWorkingSetBytes } from '../browser/cgroup.js';
import { BrowserPool } from '../browser/pool.js';
import { chromiumSandboxCheck, seccompMode, type ChromiumSandboxStatus } from '../browser/sandbox-check.js';
import { ProcessSandboxEngine, sandboxOptionsFromEnv, type IsolationProbe } from '../sandbox/index.js';
import type { ExecutorFactory } from '../worker.js';
import { loadInlineScript } from './script-executor.js';
import { TunnelJobClient } from '../tunnel/client.js';
import type { EngineFactory } from './agent-executors.js';
import { createInvestigationExecutor, dispatchByKind } from './investigation-executor.js';
import { createRepairPort } from './repair-executor.js';
import { createJudgeJob, settingsQualityPorts } from './quality-job.js';
import { createStrategyRuntime, type AgentPorts } from './strategy-executor.js';

/**
 * Rôles résolus pour l'enquête (schéma, prix des couples E4 et E6). Le rôle `judge` n'en fait PAS partie (revue 2.12) :
 * il est résolu à part (`judgeLlm`), et une erreur de ses réglages n'empêche jamais l'enquête.
 */
export const INVESTIGATION_LLM_ROLES = ['investigate', 'extract', 'agent'] as const;

/** Version du prompt du moteur : celui de Stagehand, non modifié (mesuré tel quel au spike 0.6a). */
const STAGEHAND_PROMPT_VERSION = `stagehand-${STAGEHAND_VERSION}-dom`;

/**
 * Moteur du rôle `agent` (ADR 0001) : Stagehand 3.7.3 en local sur le Chromium dédié de l'essai. Il appelle le
 * fournisseur hors du LlmClient : `llm.redact` des réglages lui est donc passé (masquage dans son middleware, 08 §1),
 * avec les points d'accroche de l'essai (plafond de coût partagé, garde de classification). Un modèle sans prix reste
 * permis (08 §1 : coût null avec avertissement) ; le plafond étant alors intenable, le run s'arrête après le premier appel.
 */
export function stagehandEngineFor(config: LlmConfig, env: NodeJS.ProcessEnv = process.env, onNote?: (note: LlmNote) => void): EngineFactory {
  return ({ cdpUrl, recorder, hooks, phase }) => {
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
        // Profil sondé : un paramètre d'échantillonnage refusé par le modèle (claude-opus-4-8) n'est jamais envoyé.
        ...(profile === undefined ? {} : { profile }),
        ...(onNote === undefined ? {} : { onSamplingDropped: (param) => onNote({ event: 'llm_sampling_param_dropped', provider: target.provider.id, model: target.model.id, param }) }),
        // Profil sans mesure (route de sonde pas encore livrée) : un 400 qui nomme le paramètre => nouvel essai sans lui, noté.
        ...(onNote === undefined ? {} : { onSamplingRejected: (param) => onNote({ event: 'llm_sampling_param_rejected', provider: target.provider.id, model: target.model.id, param }) }),
        ...(config.redact === undefined ? {} : { redact: config.redact }),
        phase,
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
  /** Vérification du bac à sable de Chromium au démarrage (tests) ; défaut : `chromiumSandboxCheck()`. */
  readonly chromiumSandbox?: () => Promise<ChromiumSandboxStatus>;
};

export function productionExecutorFactory(env: Readonly<Record<string, string | undefined>> = process.env, overrides: ProductionFactoryOverrides = {}): ExecutorFactory {
  return async ({ pool, config, checked, logger, queue }) => {
    const guard = new SsrfGuard({ policy: ssrfPolicyFromEnv(env) });
    // PA-02 : plafonds d'instance appliqués à ce que le worker lit en base (import, lignes antérieures).
    const costCaps = costCapsFromEnv(env);
    const pacer = new DomainPacer(new PgPacingStore(pool));
    const secrets = secretStore(pool, config.keyring, checked);
    const production = env['NODE_ENV'] === 'production';
    const sandbox = sandboxOptionsFromEnv(env);
    const engine: FactoryEngine =
      overrides.sandboxEngine?.({ production }) ??
      new ProcessSandboxEngine({
        ...sandbox,
        production,
        onSweepFailure: (message) => logger.error({ alert: 'sandbox_sweep_failed' }, message),
      });
    if (production) {
      const probe = await engine.probeIsolation();
      if (probe.parentEnviron === 'readable') {
        throw new SandboxIsolationError("bac à sable : l'enfant lit l'environnement du worker (utilisateur dédié requis, D-30)");
      }
      // Sous no-new-privileges, /proc/<worker>/environ est refusé même à un enfant du MÊME uid (le worker détient des
      // capacités permises) : la séparation se prouve par l'uid de l'enfant et par le fichier témoin du worker (revue 4.1b).
      if (probe.uid === undefined || probe.uid === 0 || probe.uid === process.getuid?.() || (sandbox.uid !== undefined && probe.uid !== sandbox.uid)) {
        throw new SandboxIsolationError(`bac à sable : l'enfant ne tourne pas sous l'uid dédié (uid ${String(probe.uid)}, attendu ${String(sandbox.uid)}, D-30)`);
      }
      if (probe.witness !== 'denied') {
        throw new SandboxIsolationError("bac à sable : l'enfant lit les fichiers du worker (fichier témoin), utilisateur dédié requis (D-30)");
      }
      // Le profil seccomp du compose permet les espaces de noms utilisateur à tout le conteneur (bac à sable de Chromium) :
      // l'enfant doit les perdre (filtre SANDBOX_SECCOMP, revue 4.1b).
      if (probe.namespaces === 'allowed') {
        throw new SandboxIsolationError("bac à sable : l'enfant peut créer un espace de noms utilisateur (filtre SANDBOX_SECCOMP requis, revue 4.1b)");
      }
      // Régime seccomp du conteneur (champ Seccomp de /proc/self/status : 0 aucun, 2 filtre) : relevé sur chaque hébergeur.
      logger.info({ sandboxUid: probe.uid, noNewPrivs: probe.noNewPrivs, namespaces: probe.namespaces, seccomp: seccompMode() ?? 'inconnu' }, 'bac à sable : isolation éprouvée');
    }
    let browsers: BrowserPool | null = null;
    let launchProxy: EgressProxy | undefined;
    let provider: BrowserProvider | undefined;
    if (!config.disableBrowser) {
      launchProxy = await startEgressProxy({
        guard,
        refuseAll: true,
        onRequest: (target) => logger.warn({ host: target.host, port: target.port }, 'Chromium : trafic hors contexte de run refusé'),
      });
      const limit = cgroupMemoryLimitBytes();
      // `BROWSER_URL` absente : Chromium local ; présente : SYM Browser (04g §2). Un SYM Browser qui ne répond pas encore ne
      // retient pas le démarrage : l'ouverture des sessions attend et réessaie (worker_starts_without_browser).
      const launchProxyUrl = launchProxy.url;
      provider = await detectProvider(env, fetch, { createLocal: () => createLocalProvider({ launchProxyUrl, env }) });
      logger.info({ kind: provider.kind, capabilities: provider.capabilities }, 'fournisseur de navigateur');
      // Publié pour la console (Réglages > Navigateur) : genre, capacités, activation ; jamais d'adresse ni de secret. Best-effort.
      try {
        await publishBrowserProvider(pool, { kind: provider.kind, capabilities: provider.capabilities, genericCdpEnabled: env['BROWSER_ALLOW_GENERIC_CDP'] === 'true' });
      } catch (error) {
        logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'fournisseur de navigateur : publication impossible');
      }
      if (provider.kind === 'cdp') {
        logger.warn({ absentCapabilities: CDP_ABSENT_CAPABILITIES }, 'navigateur CDP générique : capacités côté navigateur absentes (la garde SSRF, le verrou de domaines et le masquage restent tenus par SYM)');
      }
      browsers = new BrowserPool({
        size: config.browserConcurrency,
        launch: provider.launchShared,
        // Pas de contexte neuf par run (fournisseur `cdp`) : une session fournisseur par run, le navigateur est rendu après chaque run.
        ...(provider.capabilities.freshContextPerRun ? {} : { recycleAfterRuns: 1 }),
        ...(limit === undefined ? {} : { memoryHigh: () => (cgroupMemoryWorkingSetBytes() ?? 0) > limit * BROWSER_MEMORY_RECYCLE_RATIO }),
        onEvent: (event) => logger.info(event, 'navigateur'),
      });
      logger.info({ browserConcurrency: config.browserConcurrency, source: config.browserConcurrencySource }, 'pool Chromium prêt (lancement à la demande)');
      // Bac à sable de Chromium (jamais --no-sandbox) : sans espaces de noms utilisateur (profil seccomp par défaut de Docker,
      // AppArmor de l'hôte), chaque run navigateur s'arrêterait sur « No usable sandbox! ». Dit dès le démarrage, sans
      // empêcher les runs sans navigateur (revue 4.1b : Render n'applique pas le profil du compose).
      if (production && provider.kind === 'local') {
        const status = await (overrides.chromiumSandbox ?? chromiumSandboxCheck)();
        const seccomp = seccompMode() ?? 'inconnu';
        if (status.available) logger.info({ seccomp }, 'Chromium : bac à sable disponible');
        else {
          logger.error(
            { alert: 'chromium_sandbox_unavailable', seccomp, detail: status.detail },
            "Chromium : bac à sable indisponible (espaces de noms utilisateur refusés par le profil seccomp ou AppArmor de l'hôte) : les runs navigateur échoueront (« No usable sandbox! »). Docker : profil seccomp-chromium.json (security_opt du worker), voir docs/deploiement.md",
          );
        }
      }
    }
    const pool_ = browsers;
    // E4-E6 (tâche 2.4) : réglages LLM relus à chaque essai, clés dans le dépôt de secrets (INV8).
    const agent: AgentPorts = {
      llmConfig: async () => {
        const value = await readLlmSettings(pool);
        return value === null ? null : llmConfigFromSettings(value, (id) => secrets.get(id), ['extract', 'agent']);
      },
      client: (config) => createLlmClient(config, { note: (note) => logger.info(note, 'llm') }),
      engineFor: (config) => stagehandEngineFor(config, env as NodeJS.ProcessEnv, (note) => logger.info(note, 'llm')),
      // Lancé par les exécuteurs E5 et E6 DANS un slot du pool (BrowserPool.hold) : BROWSER_CONCURRENCY le borne (14 §11).
      agentBrowser: (options) => launchAgentBrowser({ ...options, env, ...(provider === undefined ? {} : { provider }) }),
    };
    // Mode tunnel (2.7) : commandes par `tunnel_jobs`, réponses réveillées par LISTEN sur la connexion de session.
    const tunnel = new TunnelJobClient({ pool, sessionUrl: config.databaseUrlDirect ?? config.databaseUrl, logger });
    await tunnel.start();
    // Module d'accès (1.11) : contact de l'instance relu à chaque run (réglage de l'assistant, puis INSTANCE_CONTACT),
    // identification de l'instance relue aussi (réglage `identify_instance`, puis IDENTIFY_INSTANCE, désactivée par
    // défaut), version annoncée dans le jeton du User-Agent.
    // Moteur embarqué publié pour la console (tâche 3.8b) : elle en déduit le User-Agent réel, affiché en lecture seule, avec la
    // version que CE worker annonce dans le jeton et les replis de SON environnement (IDENTIFY_INSTANCE, INSTANCE_CONTACT), que le
    // serveur ne voit pas : l'aperçu de la console est ce qui part sur le fil. Best-effort : un échec ne retient pas le démarrage.
    try {
      const fallbacks = identityFromEnv(env);
      await publishRobotEngine(pool, { ...installedEngineIdentity(), productVersion: config.version, identifyInstanceEnv: fallbacks.identifyInstance, instanceContactEnv: fallbacks.instanceContact, instanceContactEnvInvalid: instanceContactEnvInvalid(env) });
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'moteur embarqué : publication impossible');
    }
    const instanceContact = async (): Promise<string | null> => resolveInstanceContact(await readInstanceContactSetting(pool), env);
    const identifyInstance = async (): Promise<boolean> => resolveIdentifyInstance(await readIdentifyInstanceSetting(pool), env);
    // Réparation dans le même run (2.3) et reprise par étape (2.13) : rôles `repair` et `agent` relus à chaque réparation, bail en table ; seuil de casse des items
    // non conformes (D-49) lu au démarrage (`ITEMS_REJECTED_MAX_SHARE`, `ITEMS_REJECTED_MIN_COUNT`).
    // Juge consultatif (2.12) : désactivé par défaut (`settings.llm.judge.enabled` et un modèle au rôle `judge`). Sur
    // anomalie d'un rejeu, le jugement est un job pg-boss séparé (`quality-judge`, un par run) traité par le worker après
    // la fin du run (le rejeu ne fait aucun appel LLM) ; il survit à un redémarrage.
    const judgeLlm = {
      config: async () => {
        const value = await readLlmSettings(pool);
        return value === null ? null : llmConfigFromSettings(value, (id) => secrets.get(id), ['judge']);
      },
      client: (config: LlmConfig) => createLlmClient(config, { note: (note) => logger.info(note, 'llm') }),
    };
    const qualityBase = settingsQualityPorts(pool);
    const judgeJob = createJudgeJob({ pool, llm: judgeLlm, quality: qualityBase });
    const quality = {
      ...qualityBase,
      scheduleJudge: async (job: { runId: string; ownerId: string }) => {
        const q = queue?.();
        if (q === undefined) {
          logger.warn({ runId: job.runId }, 'juge : file indisponible, jugement sur anomalie non planifié');
          return;
        }
        await scheduleRunJudge(q, job);
      },
    };
    const repair = createRepairPort({
      pool,
      browser: pool_ !== null,
      logger,
      llm: {
        config: async () => {
          const value = await readLlmSettings(pool);
          // `agent` : agent d'étape de la reprise par étape (2.13, niveaux 2 et 3).
          return value === null ? null : llmConfigFromSettings(value, (id) => secrets.get(id), ['repair', 'agent']);
        },
        client: (config) => createLlmClient(config, { note: (note) => logger.info(note, 'llm') }),
      },
      judgeLlm,
    });
    const strategy = createStrategyRuntime({
      pool,
      guard,
      pacer,
      browsers,
      ...(provider === undefined ? {} : { openEgress: (egressOptions) => provider.openEgress(egressOptions) as Promise<RunEgress> }),
      secrets,
      logger,
      tunnel,
      script: { engine, loadScript: loadInlineScript },
      agent,
      instanceContact,
      identifyInstance,
      version: config.version,
      repair,
      rejection: rejectionThresholdsFromEnv(env),
      quality,
      costCaps,
    });
    // Enquête (2.1) : mêmes gardes, mêmes exécuteurs ; rôles `investigate` (schéma), `extract` et `agent` (prix des couples E4, E6).
    const investigation = createInvestigationExecutor({
      pool,
      guard,
      pacer,
      browsers,
      ...(provider === undefined ? {} : { openEgress: (egressOptions) => provider.openEgress(egressOptions) as Promise<RunEgress> }),
      secrets,
      logger,
      strategy,
      // Dossier d'enquête (2.14) : bornes BRIEF_* (sondes, part du budget, mémoire négative, budget du prompt).
      briefConfig: briefConfigFromEnv(process.env),
      // Session requise ou tunnel seul (04 §4) : étape 0 et reconnaissance par l'extension du propriétaire.
      tunnel,
      agentic: true,
      llm: {
        config: async () => {
          const value = await readLlmSettings(pool);
          return value === null ? null : llmConfigFromSettings(value, (id) => secrets.get(id), [...INVESTIGATION_LLM_ROLES]);
        },
        client: (config) => createLlmClient(config),
      },
      judgeLlm,
      quality,
      instanceContact,
      identifyInstance,
      version: config.version,
      costCaps,
    });
    return {
      executor: dispatchByKind({ run: strategy.executor, investigation }),
      // Job `quality-judge` : jugement sur anomalie d'un rejeu, après sa clôture (RunNotClosedError : pg-boss le reprend).
      judge: async (job) => {
        await judgeJob({ runId: job.run_id, ownerId: job.owner_id, trigger: 'anomaly' });
      },
      browserContexts: () => pool_?.active() ?? 0,
      close: async () => {
        await tunnel.close();
        await pool_?.close();
        await launchProxy?.close();
      },
    };
  };
}
