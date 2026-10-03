// SPDX-License-Identifier: AGPL-3.0-only
// Garde de requêtes de l'agent (règle des deux, 19 §7, r6 R4 ; constat PA-01 du pré-audit 4.3) : `agentRequestPolicy`
// (packages/core/src/agent/phases.ts) branchée sur le crochet `checkRequest` du navigateur agentique, donc sur CHAQUE
// requête http(s) d'un domaine de l'API et chaque poignée de main WebSocket, avant toute connexion.
// - navigation de l'agent (requête Document, cadre principal OU cadre enfant : un formulaire `target=<iframe>` n'y échappe
//   pas) : politique complète, l'URL doit venir du départ, du DOM de la page (formulaires GET sérialisés avec leurs valeurs
//   PAR DÉFAUT, jamais la saisie de l'agent), d'un gabarit `{param}` déclaré ou de la dernière navigation admise ;
// - écriture (méthode autre que GET, HEAD, OPTIONS) : refusée sans `allow_write_actions` (`method_not_allowed`) ; avec, le
//   contrôle des valeurs sensibles porte sur l'URL ET sur le corps ;
// - toute autre requête (sous-ressource et XHR de la page, saut de redirection) : trafic de la page, sans exigence d'origine
//   ni plafond de paramètres : seules les valeurs sensibles sont refusées (limite résiduelle : le JS de la page lit ce que
//   l'agent tape, voir le rapport 4.3) ;
// - sans geste d'agent (`agentActive` faux : E4 par navigateur, étapes code de E5 hors étape `agent`) : le trafic de la
//   page garde son régime d'avant la garde, seules les valeurs sensibles et la méthode d'écriture sont contrôlées ;
// - hôtes hors des domaines de l'API : coupés plus tôt par le verrou de domaines (non consultés ici).
// Une requête refusée est coupée (`Fetch.failRequest`, l'agent voit l'échec de navigation) ; le relevé ne garde que des
// CODES (`reasons`), jamais l'URL, un hôte ni une valeur.
import { agentRequestPolicy, bodyHasSensitiveValue, isUrlTemplate, secretValues, toolRegistryForPhase, type AgentPhase, type AgentRequestContext, type PhaseContext } from '@runtime/core';
import type { CDPSession, Page } from 'playwright-core';
import type { BrowserRequestCheck, RequestCheck } from './request-guard.js';

export type AgentRequestGateOptions = {
  /** Phase de l'agent : le registre de la phase doit offrir `navigate` pour qu'une navigation de l'agent soit admise. */
  readonly phase: AgentPhase;
  readonly phaseContext?: PhaseContext;
  readonly allowedHosts: readonly string[];
  /**
   * URL de départ de la stratégie et URL des étapes `goto` d'un E5 : connues d'avance. Une URL littérale est une URL CONNUE
   * (valeurs de ses paramètres comprises), seule une URL à emplacement `{param}` est un gabarit (valeurs contrôlées).
   */
  readonly startUrl?: string;
  readonly templates?: readonly string[];
  /** Entrées du run (seules valeurs librement admises vers le domaine cible). */
  readonly runInputs?: Readonly<Record<string, unknown>>;
  /** Valeurs sensibles du run (registre de masquage RGPD, secrets) : jamais dans une URL. Relues à chaque requête. */
  readonly sensitiveValues?: () => readonly string[];
  /** Consigne du propriétaire de l'API : ses mots sont des valeurs de confiance (recherche demandée par la tâche). */
  readonly trustedText?: string;
  readonly allowWriteActions: boolean;
  /** Un agent pilote-t-il la page (défaut : oui) ? Faux : trafic de la page au régime sans agent (E4, étapes code de E5). */
  readonly agentActive?: boolean;
  /** URL présentes dans le DOM de la page du run (liens, formulaires GET) ; défaut : lecture de la page attachée. */
  readonly domUrls?: () => Promise<readonly string[]>;
};

export type AgentRequestGate = {
  readonly check: RequestCheck;
  /** Page du run, dont le DOM sert de source aux URL connues (appelé après le lancement du navigateur). */
  attach(page: Page): void;
  /** Refus décidé par une couche antérieure du navigateur (garde d'écriture du contexte) et rapporté ici pour le journal. */
  record(reason: string): void;
  /** Complète le journal pour qu'il porte au moins `count` refus d'écriture (`method_not_allowed`), sans double compte. */
  ensureWriteRefusals(count: number): void;
  /** Un agent pilote-t-il la page en ce moment ? Basculé autour de chaque étape `agent` d'un E5 et de la reprise d'étape. */
  setAgentActive(active: boolean): void;
  isAgentActive(): boolean;
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

/**
 * Liens, cadres et envois de formulaire GET du DOM de la page (cadre principal) : script exécuté dans la page (le worker n'a
 * pas les types DOM), borné. Un formulaire est sérialisé avec ses valeurs PAR DÉFAUT (attribut `value`, `defaultValue`,
 * options `selected`), jamais la valeur COURANTE : ce que l'agent a tapé ne devient pas une URL « connue ». Les choix d'une liste,
 * d'une case ou d'une radio sont des valeurs de la page : chacun donne une URL.
 */
const READ_DOM_URLS = `(() => {
  const out = [];
  for (const a of Array.from(document.querySelectorAll('a[href],area[href],iframe[src],frame[src]'))) out.push(a.href || a.src);
  const skip = ['submit', 'button', 'image', 'reset', 'file'];
  for (const form of Array.from(document.forms)) {
    if ((form.method || 'get').toLowerCase() !== 'get') continue;
    try {
      const base = [];
      const choices = [];
      for (const el of Array.from(form.elements)) {
        if (!el.name || el.disabled) continue;
        const type = String(el.type || '').toLowerCase();
        if (skip.includes(type)) continue;
        if (type === 'checkbox' || type === 'radio') {
          const v = el.getAttribute('value');
          const pair = [el.name, v == null ? 'on' : v];
          if (el.defaultChecked) base.push(pair); else choices.push(pair);
        } else if (el.tagName === 'SELECT') {
          const opts = Array.from(el.options);
          const picked = opts.filter((o) => o.defaultSelected);
          for (const o of picked.length > 0 ? picked : opts.slice(0, 1)) base.push([el.name, o.value]);
          for (const o of opts) choices.push([el.name, o.value]);
        } else base.push([el.name, el.defaultValue == null ? '' : String(el.defaultValue)]);
      }
      const build = (pairs) => {
        const u = new URL(form.action || location.href);
        u.search = '';
        for (const [n, v] of pairs) u.searchParams.append(n, v);
        return u.href;
      };
      out.push(build(base));
      for (const [n, v] of choices.slice(0, 200)) out.push(build([...base.filter((p) => p[0] !== n), [n, v]]));
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
  let writeRefusals = 0;
  let agentActive = options.agentActive !== false;
  let page: Page | undefined;
  /** URL vues dans le DOM des pages chargées (relevé à chaque chargement, puis à la demande) : accumulées, bornées. */
  const domSeen = new Set<string>();
  const trusted = wordsOf(options.trustedText);
  // URL littérales (départ, `goto`) : URL connues, valeurs comprises. Seuls les vrais gabarits `{param}` restent des gabarits.
  const declared = [...(options.startUrl === undefined ? [] : [options.startUrl]), ...(options.templates ?? []).filter((t) => !isUrlTemplate(t))];
  const templates = (options.templates ?? []).filter(isUrlTemplate);

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

  const sensitive = (): readonly string[] => options.sensitiveValues?.() ?? [];
  const context = (domUrls: readonly string[], trafficUrls: readonly string[]): AgentRequestContext => ({
    targetHosts: options.allowedHosts,
    targetSuffixes: [],
    domUrls: [...declared, ...domUrls],
    trafficUrls,
    templates,
    runInputs: options.runInputs ?? {},
    sensitiveValues: sensitive(),
    trustedValues: trusted,
  });
  /** Trafic de la page : seules les valeurs sensibles sont contrôlées (ni plafond de paramètres ni exigence d'origine). */
  const trafficContext = (url: string): AgentRequestContext => ({ ...context([], [url]), maxParams: Number.MAX_SAFE_INTEGER, maxParamLength: Number.MAX_SAFE_INTEGER });

  const refuse = (reason: string): false => {
    blocked += 1;
    if (reason === 'method_not_allowed') writeRefusals += 1;
    if (reasons.length < MAX_REASONS) reasons.push(reason);
    return false;
  };

  const check: RequestCheck = async (hop: BrowserRequestCheck) => {
    const write = !READ_METHODS.has(hop.method.toUpperCase());
    if (write) {
      // Sans `allow_write_actions`, aucune écriture (formulaire POST, XHR, beacon) ; avec, l'URL ET le corps ne portent aucune valeur sensible.
      if (!options.allowWriteActions) return refuse('method_not_allowed');
      const decision = agentRequestPolicy({ method: 'GET', url: hop.url }, trafficContext(hop.url));
      if (!decision.allowed) return refuse(decision.reason);
      if (hop.body !== undefined && hop.body !== '' && bodyHasSensitiveValue(hop.body, sensitive(), options.runInputs ?? {})) return refuse('sensitive_value');
      return true;
    }
    const navigation = hop.resourceType === 'Document' && !hop.redirect;
    if (!navigation || !agentActive) {
      // Trafic de la page (sous-ressource, XHR, redirection) ou page sans agent : l'URL vient de la page par définition.
      const decision = agentRequestPolicy({ method: 'GET', url: hop.url }, trafficContext(hop.url));
      if (!decision.allowed) return refuse(decision.reason);
      if (navigation && hop.mainFrame) remember(hop.url);
      return true;
    }
    // Navigation de l'agent (cadre principal ou enfant) : l'outil doit être dans le registre de la phase, l'URL venir de la page.
    if (hop.mainFrame && !navigationOffered && !declared.includes(hop.url)) return refuse('tool_not_in_phase');
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
    ensureWriteRefusals: (count) => {
      while (writeRefusals < count) refuse('method_not_allowed');
    },
    setAgentActive: (active) => {
      agentActive = active;
    },
    isAgentActive: () => agentActive,
    summary: () => ({ blocked, reasons: [...reasons] }),
  };
}

/** Valeurs sensibles du run pour la politique : données personnelles vues (registre du run), secrets du processus et leurs encodages (base64, URL…). */
export function runSensitiveValues(personal: { values(): string[] }): () => string[] {
  return () => [...personal.values(), ...secretValues.values(), ...secretValues.variants()];
}
