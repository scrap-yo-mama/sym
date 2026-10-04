// SPDX-License-Identifier: AGPL-3.0-only
// Sonde du code (tâche 2.14, 19c § 3, r7 R4) : chaque indice vérifiable est vérifié SANS LLM avant que l'agent s'y fie.
// `endpoint` et `example_url` : une requête GET chacun, jamais avec la méthode déclarée, par le PIPELINE D'ACCÈS de l'API
// (port `check` = portée de l'API, puis port `get` = session réseau gardée : SSRF à chaque saut, cadence, plafond de
// coût ; classifieur de 04 § 7). Le robots.txt n'est jamais lu par la sonde (D-91). Au plus `BRIEF_PROBE_MAX` sondes
// et `BRIEF_PROBE_BUDGET_SHARE` du budget d'enquête ; coupe-circuit après deux sondes en échec : l'enquête continue sans
// le dossier. Un 403 signé ou un défi pendant une sonde arrête tout (`blocking`) ; tout autre refus est un échec de sonde : l'exécuteur applique la classe (`bloquee`),
// aucune escalade. Une sonde ne lit jamais `seen_on`, `tried.target` ni `sample` : seuls `endpoint` et `example_url`
// peuvent produire une requête.
import type { ExecFailure, HttpExchange } from '../exec/types.js';
import type { FailureClass } from '../model/index.js';
import { BRIEF_DEFAULTS, DEFAULT_BRIEF_CONFIG, type BriefConfig, type BriefReason } from './schema.js';
import { probeOrder, type BriefDigest, type DigestHint } from './digest.js';

export type BriefProbePorts = {
  /** Portée de l'API (hôtes, http ou https) AVANT toute requête. */
  readonly check: (url: string) => Promise<{ readonly allowed: true } | { readonly allowed: false; readonly failure: ExecFailure }>;
  /** GET par le pipeline d'accès de l'API ; `failure` : erreur de transport ou refus de garde déjà classé. */
  readonly get: (url: string) => Promise<{ readonly exchange: HttpExchange; readonly costUsd: number; readonly ms: number } | { readonly failure: ExecFailure; readonly costUsd: number; readonly ms: number }>;
  /** Classifieur (04 § 7) : la seule autorité sur un refus. */
  readonly classify: (exchange: HttpExchange, url: string) => ExecFailure | null;
  /** Données servies par un `endpoint` (nombre d'enregistrements reconnus par la reconnaissance), `null` sinon. */
  readonly records: (exchange: HttpExchange, url: string) => number | null;
  readonly now?: () => number;
};

export type ProbeFacts = { readonly at: string; readonly http_class: string; readonly items_conform: number | null; readonly duration_ms: number; readonly cost_usd: number };

export type ProbeResult = {
  readonly id: string;
  readonly identity_key: string;
  readonly outcome: 'verified' | 'probe_failed' | 'skipped';
  readonly reason: BriefReason | null;
  readonly url: string;
  readonly probe: ProbeFacts | null;
  /** Réponse d'un `endpoint` vérifié : versée à la reconnaissance comme gabarit déclaré par le code. */
  readonly exchange: HttpExchange | null;
};

export type ProbeRun = {
  readonly results: readonly ProbeResult[];
  /** Refus ou défi pendant une sonde : l'exécuteur arrête l'enquête par la classe (aucune escalade). */
  readonly blocking: ExecFailure | null;
  readonly breakerOpen: boolean;
  readonly spentUsd: number;
  readonly requests: number;
};

/**
 * Classes qui arrêtent la sonde ET l'enquête : le défi ou le 403 signé (`blocked_by_protection`) et la cadence. Un 403
 * ordinaire, un 401, une redirection vers la connexion, un paiement ou une limite de compte sont des échecs de SONDE : le
 * dossier est une donnée non fiable, il ne peut pas fabriquer un refus du domaine (19c § 3).
 */
const BLOCKING = new Set<FailureClass>(['blocked_by_protection', 'rate_limited']);

/** Hôte hors portée ou refusé par la garde SSRF (y compris après une redirection) : l'indice est ignoré, sans échec compté. */
const hostIgnored = (f: ExecFailure) => f.detail === 'domain_not_allowed' || f.detail === 'ssrf_blocked';

const httpClass = (status: number) => (status >= 200 && status < 300 ? '2xx' : status >= 300 && status < 400 ? '3xx' : status >= 400 && status < 500 ? '4xx' : status >= 500 ? '5xx' : 'other');

/** URL sondée : celle de l'indice, toujours en GET (la méthode déclarée n'est jamais rejouée). */
function probeUrl(hint: DigestHint): string | null {
  const p = hint.parsed;
  if (p === null || (p.kind !== 'endpoint' && p.kind !== 'example_url')) return null;
  return p.url.href;
}

/**
 * Sondes d'un dossier. `budgetUsd` : budget d'enquête (`investigation_budget_usd`) ; la sonde n'en consomme au plus que
 * `BRIEF_PROBE_BUDGET_SHARE`. Rend, par indice sondé, `verified` (réponse conforme : 2xx non classée en refus, données
 * reconnues pour un `endpoint`), `probe_failed` (jamais « vérifié », quelle que soit la confiance déclarée) ou `skipped`
 * (portée, plafond, coupe-circuit).
 */
export async function runBriefProbes(digest: BriefDigest, ports: BriefProbePorts, limits: { readonly budgetUsd: number; readonly config?: BriefConfig }): Promise<ProbeRun> {
  const config = limits.config ?? DEFAULT_BRIEF_CONFIG;
  const now = ports.now ?? Date.now;
  const share = Math.max(0, Math.min(limits.budgetUsd, limits.budgetUsd * config.probeBudgetShare));
  const results: ProbeResult[] = [];
  let spent = 0;
  let failures = 0;
  let requests = 0;
  let blocking: ExecFailure | null = null;
  const skip = (hint: DigestHint, url: string, reason: BriefReason) => results.push({ id: hint.id, identity_key: hint.identity_key, outcome: 'skipped', reason, url, probe: null, exchange: null });
  for (const hint of probeOrder(digest).slice(0, config.probeMax)) {
    const url = probeUrl(hint);
    if (url === null) continue;
    if (blocking !== null) {
      skip(hint, url, 'brief_breaker_open');
      continue;
    }
    if (failures >= BRIEF_DEFAULTS.breakerFailures) {
      skip(hint, url, 'brief_breaker_open');
      continue;
    }
    if (spent >= share) {
      skip(hint, url, 'brief_over_budget');
      continue;
    }
    // Portée AVANT la requête : un hôte hors de l'API ne produit aucune requête, l'enquête continue.
    const decision = await ports.check(url);
    if (!decision.allowed) {
      const cls = decision.failure.failure_class;
      if (hostIgnored(decision.failure)) skip(hint, url, 'brief_host_ignored');
      else if (BLOCKING.has(cls)) {
        blocking = decision.failure;
        skip(hint, url, 'brief_breaker_open');
      } else {
        failures += 1;
        results.push({ id: hint.id, identity_key: hint.identity_key, outcome: 'probe_failed', reason: 'brief_probe_failed', url, probe: { at: new Date(now()).toISOString(), http_class: 'none', items_conform: null, duration_ms: 0, cost_usd: 0 }, exchange: null });
      }
      continue;
    }
    requests += 1;
    const got = await ports.get(url);
    spent += got.costUsd;
    const at = new Date(now()).toISOString();
    if ('failure' in got) {
      if (hostIgnored(got.failure)) {
        skip(hint, url, 'brief_host_ignored');
        continue;
      }
      if (BLOCKING.has(got.failure.failure_class)) {
        blocking = got.failure;
        results.push({ id: hint.id, identity_key: hint.identity_key, outcome: 'probe_failed', reason: 'brief_probe_failed', url, probe: { at, http_class: 'none', items_conform: null, duration_ms: got.ms, cost_usd: got.costUsd }, exchange: null });
        continue;
      }
      failures += 1;
      results.push({ id: hint.id, identity_key: hint.identity_key, outcome: 'probe_failed', reason: 'brief_probe_failed', url, probe: { at, http_class: 'none', items_conform: null, duration_ms: got.ms, cost_usd: got.costUsd }, exchange: null });
      continue;
    }
    const refused = ports.classify(got.exchange, url);
    const facts = (items: number | null): ProbeFacts => ({ at, http_class: httpClass(got.exchange.status), items_conform: items, duration_ms: got.ms, cost_usd: got.costUsd });
    if (refused !== null && hostIgnored(refused)) {
      skip(hint, url, 'brief_host_ignored');
      continue;
    }
    if (refused !== null) {
      if (BLOCKING.has(refused.failure_class)) blocking = refused;
      else failures += 1;
      results.push({ id: hint.id, identity_key: hint.identity_key, outcome: 'probe_failed', reason: 'brief_probe_failed', url, probe: facts(null), exchange: null });
      continue;
    }
    const ok = got.exchange.status >= 200 && got.exchange.status < 300;
    const items = ok && hint.kind === 'endpoint' ? ports.records(got.exchange, url) : null;
    if (!ok || (hint.kind === 'endpoint' && (items === null || items === 0))) {
      failures += 1;
      results.push({ id: hint.id, identity_key: hint.identity_key, outcome: 'probe_failed', reason: 'brief_probe_failed', url, probe: facts(items), exchange: null });
      continue;
    }
    results.push({ id: hint.id, identity_key: hint.identity_key, outcome: 'verified', reason: null, url, probe: facts(items), exchange: hint.kind === 'endpoint' ? got.exchange : null });
  }
  return { results, blocking, breakerOpen: failures >= BRIEF_DEFAULTS.breakerFailures, spentUsd: Math.round(spent * 1e6) / 1e6, requests };
}
