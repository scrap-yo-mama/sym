// SPDX-License-Identifier: AGPL-3.0-only
// Garde de requêtes de l'agent (règle des deux, 19 §7, r6 R4 ; constat PA-01 du pré-audit 4.3) : `agentRequestPolicy`
// (packages/core/src/agent/phases.ts) branchée sur le crochet `checkRequest` du navigateur agentique, donc sur CHAQUE
// requête http(s) d'un domaine de l'API et chaque poignée de main WebSocket, avant toute connexion.
// - navigation du cadre principal (le geste de l'agent : `goto`, clic sur un lien, envoi d'un formulaire GET) : politique
//   complète, l'URL doit venir du départ, d'un gabarit déclaré, du DOM de la page ou du trafic déjà vu ;
// - écriture (méthode autre que GET, HEAD, OPTIONS) : refusée sans `allow_write_actions` (`method_not_allowed`) ;
// - toute autre requête (sous-ressource de la page, saut de redirection) : trafic de la page, sans exigence d'origine, mais
//   jamais de valeur sensible dans l'URL ni de paramètre hors bornes ;
// - hôtes hors des domaines de l'API : coupés plus tôt par le verrou de domaines (non consultés ici).
// Une requête refusée est coupée (`Fetch.failRequest`, l'agent voit l'échec de navigation) ; le relevé ne garde que des
// CODES (`reasons`), jamais l'URL, un hôte ni une valeur.
import { agentRequestPolicy, toolRegistryForPhase, type AgentPhase, type AgentRequestContext, type PhaseContext } from '@runtime/core';
import type { CDPSession, Page } from 'playwright-core';
import type { BrowserRequestCheck, RequestCheck } from './request-guard.js';

export type AgentRequestGateOptions = {
  /** Phase de l'agent : le registre de la phase doit offrir `navigate` pour qu'une navigation de l'agent soit admise. */
  readonly phase: AgentPhase;
  readonly phaseContext?: PhaseContext;
  readonly allowedHosts: readonly string[];
  /** URL de départ de la stratégie, et gabarits déclarés (étapes `goto` d'un E5) : connues d'avance. */
  readonly startUrl?: string;
  readonly templates?: readonly string[];
  /** Entrées du run (seules valeurs librement admises vers le domaine cible). */
  readonly runInputs?: Readonly<Record<string, unknown>>;
  /** Valeurs sensibles du run (registre de masquage RGPD, secrets) : jamais dans une URL. Relues à chaque requête. */
  readonly sensitiveValues?: () => readonly string[];
  /** Consigne du propriétaire de l'API : ses mots sont des valeurs de confiance (recherche demandée par la tâche). */
  readonly trustedText?: string;
  readonly allowWriteActions: boolean;
  /** URL présentes dans le DOM de la page du run (liens, formulaires GET) ; défaut : lecture de la page attachée. */
  readonly domUrls?: () => Promise<readonly string[]>;
};

export type AgentRequestGate = {
  readonly check: RequestCheck;
  /** Page du run, dont le DOM sert de source aux URL connues (appelé après le lancement du navigateur). */
  attach(page: Page): void;
  /** Refus décidé par une couche antérieure du navigateur (garde d'écriture du contexte) et rapporté ici pour le journal. */
  record(reason: string): void;
  /** Refus comptés et leurs codes (jamais d'URL ni de valeur). */
  summary(): { readonly blocked: number; readonly reasons: readonly string[] };
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_SEEN = 2000;
const MAX_REASONS = 100;
const DOM_READ_TIMEOUT_MS = 1500;

/** Mots de la consigne (valeurs de recherche que la tâche demande elle-même). */
function wordsOf(text: string | undefined): string[] {
  if (text === undefined) return [];
  return [...new Set(text.split(/[\s,;:.!?()«»"'’]+/).filter((w) => w.length >= 2 && w.length <= 64))];
}

/** Liens et envois de formulaire GET du DOM de la page (cadre principal) : script exécuté dans la page (le worker n'a pas les types DOM), borné. */
const READ_DOM_URLS = `(() => {
  const out = [];
  for (const a of Array.from(document.querySelectorAll('a[href],area[href]'))) out.push(a.href);
  for (const form of Array.from(document.forms)) {
    if ((form.method || 'get').toLowerCase() !== 'get') continue;
    try {
      const u = new URL(form.action || location.href);
      for (const el of Array.from(form.elements)) if (el.name) u.searchParams.set(el.name, el.value == null ? '' : String(el.value));
      out.push(u.href);
    } catch (e) {}
  }
  return out.slice(0, 5000);
})()`;

/**
 * Lecture du DOM par une session CDP propre (`Runtime.evaluate`) : `page.evaluate` de Playwright attend le cycle de vie du
 * cadre et ne répond pas tant que la navigation qui a déclenché le contrôle est suspendue (constaté : attente jusqu'à
 * l'échéance, donc des liens légitimes refusés).
 */
const sessions = new WeakMap<Page, Promise<CDPSession>>();
async function readPageDom(page: Page): Promise<readonly string[]> {
  let session = sessions.get(page);
  if (session === undefined) {
    session = page.context().newCDPSession(page);
    sessions.set(page, session);
  }
  const result = (await (await session).send('Runtime.evaluate', { expression: READ_DOM_URLS, returnByValue: true })) as { result?: { value?: unknown } };
  const value = result.result?.value;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function createAgentRequestGate(options: AgentRequestGateOptions): AgentRequestGate {
  const registry = toolRegistryForPhase(options.phase, options.phaseContext);
  const navigationOffered = registry.tools.includes('navigate');
  const seen: string[] = [];
  const seenSet = new Set<string>();
  const reasons: string[] = [];
  let blocked = 0;
  let page: Page | undefined;
  /** URL vues dans le DOM des pages chargées (relevé à chaque chargement, puis à la demande) : accumulées, bornées. */
  const domSeen = new Set<string>();
  const trusted = wordsOf(options.trustedText);
  const templates = [...(options.templates ?? [])];

  const remember = (url: string) => {
    if (seenSet.has(url)) return;
    if (seen.length >= MAX_SEEN) seenSet.delete(seen.shift()!);
    seen.push(url);
    seenSet.add(url);
  };

  const absorb = (urls: readonly string[]) => {
    for (const u of urls) {
      if (domSeen.size >= MAX_SEEN) domSeen.delete(domSeen.values().next().value as string);
      domSeen.add(u);
    }
  };

  /** Relevé du DOM de la page du run, borné dans le temps ; en échec, ce qui a été relevé aux chargements précédents. */
  const readDom = async (): Promise<readonly string[]> => {
    const provider = options.domUrls ?? (page === undefined ? undefined : () => readPageDom(page!));
    if (provider !== undefined) {
      let timer: NodeJS.Timeout | undefined;
      try {
        absorb(await Promise.race([provider(), new Promise<readonly string[]>((resolve) => (timer = setTimeout(() => resolve([]), DOM_READ_TIMEOUT_MS)))]));
      } catch {
        // DOM illisible : seules les URL relevées plus tôt restent connues (échec fermé pour le reste).
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    return [...domSeen];
  };

  const context = (domUrls: readonly string[], trafficUrls: readonly string[]): AgentRequestContext => ({
    targetHosts: options.allowedHosts,
    targetSuffixes: [],
    domUrls,
    trafficUrls,
    templates: options.startUrl === undefined ? templates : [options.startUrl, ...templates],
    runInputs: options.runInputs ?? {},
    sensitiveValues: options.sensitiveValues?.() ?? [],
    trustedValues: trusted,
  });

  const refuse = (reason: string): false => {
    blocked += 1;
    if (reasons.length < MAX_REASONS) reasons.push(reason);
    return false;
  };

  const check: RequestCheck = async (hop: BrowserRequestCheck) => {
    const write = !READ_METHODS.has(hop.method.toUpperCase());
    if (write) {
      // Sans `allow_write_actions`, aucune écriture (formulaire POST, XHR, beacon) ; avec, seules les valeurs sensibles restent refusées.
      const decision = agentRequestPolicy({ method: options.allowWriteActions ? 'GET' : hop.method, url: hop.url }, context([], [hop.url]));
      return decision.allowed ? true : refuse(decision.reason);
    }
    const agentNavigation = hop.mainFrame && !hop.redirect;
    if (!agentNavigation) {
      // Trafic de la page (sous-ressource, redirection) : l'URL vient de la page par définition.
      const decision = agentRequestPolicy({ method: 'GET', url: hop.url }, context([], [hop.url]));
      if (!decision.allowed) return refuse(decision.reason);
      remember(hop.url);
      return true;
    }
    // Geste de navigation de l'agent : l'outil doit être dans le registre de la phase, l'URL venir de la page.
    if (!navigationOffered && hop.url !== options.startUrl && !templates.includes(hop.url)) return refuse('tool_not_in_phase');
    const decision = agentRequestPolicy({ method: 'GET', url: hop.url }, context(await readDom(), seen));
    if (!decision.allowed) return refuse(decision.reason);
    remember(hop.url);
    return true;
  };

  return {
    check,
    attach: (p) => {
      page = p;
      // Le DOM est relevé à chaque chargement : au moment d'un contrôle de navigation, l'ancien document peut déjà être détaché.
      const refresh = () => void readPageDom(p).then(absorb, () => undefined);
      p.on('domcontentloaded', refresh);
      p.on('load', refresh);
    },
    record: (reason) => void refuse(reason),
    summary: () => ({ blocked, reasons: [...reasons] }),
  };
}
