// SPDX-License-Identifier: MIT
// `BrowserProvider` (tâche 4.1 ; cdc/sym-browser 04e §2.1 et 04g §1) : l'interface par laquelle le worker de SYM obtient
// son navigateur (Chromium partagé du pool, Chromium dédié d'un essai agentique, identité du moteur, egress de l'essai),
// quel qu'en soit le lieu. Types seuls ; `playwright-core` ne sert qu'au type `Browser`.
// Les options et le résultat de l'egress de l'essai (`BrowserEgressOptions`, `BrowserEgress`) dépendent de la garde SSRF et
// des barreaux réseau de SYM : le contrat n'en fixe que la part commune (`ProviderEgress`) et l'interface les reçoit en
// paramètres de type, que le worker précise.
import type { Browser } from 'playwright-core';
import type { EgressPolicy } from './egress.js';

/** Chromium prêté au pool. */
export type LaunchedBrowser = {
  readonly browser: Browser;
  /** Fermeture propre. */
  close(): Promise<void>;
  /** Arrêt forcé (processus tué, ou session libérée). */
  kill(): Promise<void>;
};

/** Identité du moteur qui sert : version de Chromium et plateforme réelle (celle du nœud pour un fournisseur distant). */
export type EngineIdentity = {
  readonly version: string;
  readonly platform: string;
};

/** Ce qu'un fournisseur tient ; une capacité absente est déclarée, jamais simulée (04g §1). */
export type ProviderCapabilities = {
  /** Egress SYM imposé : garde SSRF réseau, verrou de domaines au saut près, budget d'octets, proxy BYO gardé, événements. */
  readonly egressPolicy: boolean;
  /** Arguments silencieux et INV11 au lancement, proxy de lancement fermé, DNS local coupé, WebRTC sans UDP hors proxy. */
  readonly launchArgs: boolean;
  /** `newContext` par run avec le proxy imposé. */
  readonly freshContextPerRun: boolean;
  /** Processus tué avant tout détachement CDP. */
  readonly killBeforeDetach: boolean;
  /** `assert_chromium_sandboxed` jouable. */
  readonly sandboxProbe: boolean;
  /** User-Agent réel du moteur posé au lancement. */
  readonly engineUserAgent: boolean;
  /** Navigateur sur le même hôte ou le réseau privé (seuils de 04e §7). */
  readonly privateLatency: boolean;
};

export type DedicatedLaunchOptions = {
  /** Posé au lancement (`--user-agent`). */
  readonly userAgent: string;
  /** Politique d'egress de l'essai (domaines, proxy amont, budget d'octets). */
  readonly egress: EgressPolicy;
  /**
   * Proxy d'egress LOCAL de l'essai (`BrowserEgress.server`), pour le fournisseur dont le navigateur passe par le worker ;
   * `null` quand le nœud distant impose lui-même l'egress.
   */
  readonly egressServer: string | null;
  /** Noms de la liste fermée des arguments de lancement (silencieux et INV11 déjà figés par le nœud). */
  readonly launchArgs: readonly string[];
  readonly launchTimeoutMs?: number;
  /** runId, attemptId, workerId. */
  readonly metadata?: Record<string, string>;
};

export type LaunchedDedicated = {
  /** Transmis à Stagehand. */
  readonly cdpUrl: string;
  /** `connectOverCDP(cdpUrl)`. */
  readonly browser: Browser;
  close(): Promise<void>;
  kill(): Promise<void>;
};

/** Part de l'egress de l'essai commune à tous les fournisseurs. */
export type ProviderEgress = {
  /** Proxy local à poser sur `newContext` ; `null` : le nœud impose le sien (aucun `proxy` sur le contexte). */
  readonly server: string | null;
  /** Fournisseur distant seulement : pose la politique sur la session une fois le navigateur connu. */
  attach?(browser: Browser): Promise<void>;
  close(): Promise<void>;
};

export interface BrowserProvider<TEgressOptions = unknown, TEgress extends ProviderEgress = ProviderEgress> {
  readonly kind: 'local' | 'sym-browser' | 'cdp';
  readonly capabilities: ProviderCapabilities;
  launchShared(): Promise<LaunchedBrowser>;
  launchDedicated(options: DedicatedLaunchOptions): Promise<LaunchedDedicated>;
  engineIdentity(): Promise<EngineIdentity>;
  openEgress(options: TEgressOptions): Promise<TEgress>;
}
