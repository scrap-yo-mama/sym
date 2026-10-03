// SPDX-License-Identifier: AGPL-3.0-only
// Rapport d'accès, étape 0 de l'enquête (tâche 1.11, 17 §2, 04 §4) : produit AVANT tout essai de contenu, stocké comme
// événement `access_report` (première ligne du journal), renvoyé dans l'objet `access` des résultats MCP et REST.
// Ordre : robots.txt (garde, cadence, SSRF) → si permis, une seule requête vers l'URL (signaux d'accès, 402, CGU,
// voies déclarées) → `llms.txt` si robots.txt le permet. Rien n'est contourné : un refus arrête l'enquête.
// - `robots_disallowed` → `bloquee`, 0 requête de contenu, texte dédié, suites : API officielle, autre source, éditeur,
//   ré-enquête ultérieure ; jamais le tunnel, jamais « ignorer » (A7, INV11) ;
// - `robots_unreachable` → `erreur` (backoff), rien n'est collecté ;
// - 402 → `payment_required`, `action_requise`, offre affichée, aucun paiement (`payment.mode: never`) ;
// - signaux d'accès et CGU : affichés, ne bloquent rien, et n'entrent JAMAIS dans un prompt (`accessFactsForPrompt`).
import { randomUUID } from 'node:crypto';
import { elementAttribute, elementText, parseHtml, selectElements } from '../dsl/css.js';
import { DEFAULT_DSL_LIMITS } from '../dsl/limits.js';
import { classifyExchange, classifyTransportError } from '../exec/classify.js';
import { failureRoute } from '../exec/guard.js';
import type { ExecFailure, HttpExchange, RequestPacer } from '../exec/types.js';
import type { NetworkSession } from '../net/modes/session.js';
import { DEFAULT_ACCESS_POLICY, type AccessPolicy } from './policy.js';
import type { RobotsDecision, RobotsGate } from './gate.js';
import { selectGroup } from './robots.js';
import { detectAccessSignals, parsePaymentOffer, type AccessSignal } from './signals.js';

/** Sonde d'une URL (une requête GET, redirections suivies sous garde robots, corps borné). */
export type AccessProbe = (url: string, signal: AbortSignal) => Promise<HttpExchange>;

/** Corps lu par la sonde (CGU, voies déclarées) : la tête de la page suffit. */
export const ACCESS_PROBE_MAX_BYTES = 256 * 1024;

export type RobotsReportStatus = 'allowed' | 'disallowed' | 'absent' | 'unreachable';

/** Suites proposées après un refus (17 §2) : liste fermée, sans tunnel ni option d'ignorance. */
export const BLOCKED_NEXT_STEPS = ['official_api', 'other_source', 'contact_publisher', 'reinvestigate_later'] as const;
export type BlockedNextStep = (typeof BLOCKED_NEXT_STEPS)[number];

export type AccessVerdict =
  | { readonly proceed: true }
  | {
      readonly proceed: false;
      readonly failure: ExecFailure;
      readonly status: 'bloquee' | 'action_requise' | 'erreur' | 'warning' | null;
      /** Texte dédié (17 §3), sans valeur de la cible hors l'offre de prix bornée. */
      readonly message: string;
      readonly what_to_do: readonly BlockedNextStep[];
    };

export type AccessReport = {
  readonly id: string;
  readonly url: string;
  readonly origin: string;
  readonly checked_at: string;
  readonly robots: {
    readonly status: RobotsReportStatus;
    readonly http_status: number | null;
    readonly fetched_at: string | null;
    readonly rule: string | null;
    readonly crawl_delay_ms: number | null;
    readonly detail: string | null;
  };
  /** Signaux d'accès : DONNÉES affichées, jamais des consignes. */
  readonly signals: readonly AccessSignal[];
  /** Lien vers des conditions d'utilisation repéré (« lire avant d'agir ») ; aucune interprétation automatique. */
  readonly terms_url: string | null;
  readonly declared: {
    readonly sitemaps: readonly string[];
    readonly feeds: readonly string[];
    readonly official_api_url: string | null;
    readonly llms_txt: boolean;
  };
  readonly payment: { readonly required: boolean; readonly offer: string | null };
  /** Statut HTTP de la sonde de l'URL (`null` si aucune requête n'est partie). */
  readonly probe_status: number | null;
  readonly policy: { readonly prefer_official: boolean; readonly on_ai_signal: 'warn' };
  readonly verdict: AccessVerdict;
};

export const ACCESS_MESSAGES = {
  robots_disallowed: 'Ce site demande aux robots de ne pas visiter cette page. Scrapyomama respecte cette règle. Options : utiliser l\'API officielle, contacter l\'éditeur.',
  robots_unreachable: 'robots.txt injoignable : par précaution rien n\'est collecté',
  payment_required: (offer: string | null) => `Le site propose un accès payant : prix ${offer ?? 'non précisé'}. Aucun paiement n'est fait : voir l'éditeur.`,
} as const;

const iso = (ms: number): string => new Date(ms).toISOString();

function stop(failure: ExecFailure, message: string): AccessVerdict {
  return { proceed: false, failure, status: failureRoute(failure.failure_class).status, message, what_to_do: [...BLOCKED_NEXT_STEPS] };
}

/** URL absolue http(s) bornée d'un lien de la page, `null` sinon. */
function absoluteLink(href: string | undefined, base: string): string | null {
  if (href === undefined || href.length > 2048) return null;
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

const TERMS = /(?:^|[^a-z])(?:cgu|cgv|terms|tos|conditions|legal|mentions[-_ ]?legales|nutzungsbedingungen|condiciones)(?:[^a-z]|$)/i;
const TERMS_TEXT = /conditions (?:g[ée]n[ée]rales|d'utilisation)|terms (?:of (?:use|service)|and conditions)|mentions l[ée]gales|cgu\b/i;
const API_LINK = /^(?:api|developers?|dev)\.|\/(?:developers?|api[-_]?docs?|docs\/api|api)(?:\/|$)/i;

/** Liens relevés au plus (au-delà, la page n'est pas lue : rapport sans CGU ni API déclarée, jamais une erreur). */
const MAX_SCANNED_LINKS = 20_000;

/** Texte court d'un lien ; vide s'il dépasse 200 caractères (carte d'annonce, menu englobant : jamais un lien de CGU). */
function linkText(a: Parameters<typeof elementText>[0]): string {
  try {
    return elementText(a, 200);
  } catch {
    return '';
  }
}

/** Éléments du sélecteur, au plus MAX_SCANNED_LINKS ; une page qui en compte plus, ou un sélecteur en échec, donne une liste vide (jamais une exception). */
function linksBestEffort(selector: string, doc: Parameters<typeof selectElements>[1]): ReturnType<typeof selectElements> {
  try {
    return selectElements(selector, doc, MAX_SCANNED_LINKS);
  } catch {
    return [];
  }
}

/** Voies déclarées et CGU lues dans la tête de la page (sans interprétation). */
function readPage(exchange: HttpExchange): { terms: string | null; feeds: string[]; officialApi: string | null } {
  const out = { terms: null as string | null, feeds: [] as string[], officialApi: null as string | null };
  if (!/html/i.test(exchange.headers['content-type'] ?? '') && !/^\s*</.test(exchange.body)) return out;
  let doc;
  try {
    doc = parseHtml(exchange.body.slice(0, ACCESS_PROBE_MAX_BYTES), DEFAULT_DSL_LIMITS);
  } catch {
    return out;
  }
  for (const link of linksBestEffort('link[rel~="alternate"][type]', doc).slice(0, 20)) {
    const type = (elementAttribute(link, 'type') ?? '').toLowerCase();
    if (!/rss|atom|feed\+json/.test(type)) continue;
    const href = absoluteLink(elementAttribute(link, 'href'), exchange.url);
    if (href !== null && out.feeds.length < 5 && !out.feeds.includes(href)) out.feeds.push(href);
  }
  for (const link of linksBestEffort('link[rel~="api"], link[rel~="service-desc"]', doc).slice(0, 5)) {
    const href = absoluteLink(elementAttribute(link, 'href'), exchange.url);
    if (href !== null) {
      out.officialApi = href;
      break;
    }
  }
  // Lecture au mieux (UX-24) : une page aux milliers de liens ou aux cartes d'annonce cliquables (texte de plus de 200
  // caractères) ne fait jamais échouer l'étape 0 ; on garde ce qui a été lu.
  // Toute la liste bornée (MAX_SCANNED_LINKS) est parcourue : le lien de CGU d'un pied de page vient après des centaines de liens.
  const anchors = linksBestEffort('a[href]', doc);
  for (const a of anchors) {
    const raw = elementAttribute(a, 'href');
    const href = absoluteLink(raw, exchange.url);
    if (href === null) continue;
    const text = linkText(a);
    if (out.terms === null && (TERMS_TEXT.test(text) || TERMS.test(new URL(href).pathname))) out.terms = href;
    if (out.officialApi === null) {
      const u = new URL(href);
      if (API_LINK.test(`${u.hostname}/`) || API_LINK.test(u.pathname)) out.officialApi = href;
    }
    if (out.terms !== null && out.officialApi !== null) break;
  }
  return out;
}

function robotsSection(decision: RobotsDecision): AccessReport['robots'] {
  const state = decision.state;
  const status: RobotsReportStatus =
    state === null || state.kind === 'unreachable' ? 'unreachable' : state.kind === 'absent' ? 'absent' : decision.allowed ? 'allowed' : 'disallowed';
  return {
    status,
    http_status: state === null ? null : state.status,
    fetched_at: state === null ? null : iso(state.fetchedAt),
    rule: decision.rule,
    crawl_delay_ms: decision.allowed ? decision.crawlDelayMs : null,
    detail: state?.kind === 'unreachable' ? state.detail : !decision.allowed && state === null ? decision.failure.detail : null,
  };
}

export type BuildAccessReportOptions = {
  readonly url: string;
  readonly gate: RobotsGate;
  /** Sonde de l'URL (session réseau AVEC le contrôle robots, User-Agent du robot). */
  readonly probe: AccessProbe;
  readonly pacer?: RequestPacer;
  readonly policy?: AccessPolicy;
  readonly signal: AbortSignal;
  readonly now?: () => number;
  /** Sonde passive de `/llms.txt` (défaut : vrai, si robots.txt la permet). */
  readonly probeLlmsTxt?: boolean;
  readonly id?: string;
};

/**
 * Étape 0 de l'enquête : le rapport d'accès. Aucune requête de contenu ne part si robots.txt l'interdit ou est
 * injoignable ; la seule requête vers l'URL est la sonde du rapport, cadencée, faite après le verdict de robots.txt.
 */
export async function buildAccessReport(options: BuildAccessReportOptions): Promise<AccessReport> {
  const now = options.now ?? Date.now;
  const policy = options.policy ?? DEFAULT_ACCESS_POLICY;
  const url = new URL(options.url);
  const base = {
    id: options.id ?? randomUUID(),
    url: url.href,
    origin: url.origin,
    policy: { prefer_official: policy.prefer_official, on_ai_signal: policy.on_ai_signal },
  };
  const decision = await options.gate.check(url.href);
  const state = decision.state;
  const robotsLines = state?.kind === 'rules' ? [...state.file.globalSignals, ...selectGroup(state.file).signals] : [];
  const sitemaps = state?.kind === 'rules' ? [...state.file.sitemaps].slice(0, 10) : [];
  const finish = (rest: Pick<AccessReport, 'signals' | 'terms_url' | 'payment' | 'probe_status' | 'verdict'> & { feeds?: string[]; officialApi?: string | null; llms?: boolean }): AccessReport => ({
    ...base,
    checked_at: iso(now()),
    robots: robotsSection(decision),
    signals: rest.signals,
    terms_url: rest.terms_url,
    declared: { sitemaps, feeds: rest.feeds ?? [], official_api_url: rest.officialApi ?? null, llms_txt: rest.llms ?? false },
    payment: rest.payment,
    probe_status: rest.probe_status,
    verdict: rest.verdict,
  });
  const noPayment = { required: false, offer: null };
  if (!decision.allowed) {
    const f = decision.failure;
    const message = f.failure_class === 'robots_disallowed' ? ACCESS_MESSAGES.robots_disallowed : f.failure_class === 'robots_unreachable' ? ACCESS_MESSAGES.robots_unreachable : f.detail;
    return finish({ signals: detectAccessSignals({}, robotsLines), terms_url: null, payment: noPayment, probe_status: null, verdict: stop(f, message) });
  }

  // Sonde de l'URL : une requête, cadencée (le `Crawl-delay` est déjà connu de la cadence).
  if (options.pacer !== undefined) {
    const slot = await options.pacer.acquire(url.href);
    if (!slot.granted) {
      const failure: ExecFailure = { failure_class: 'rate_limited', retryable: true, detail: `pacing_${slot.reason}` };
      return finish({ signals: detectAccessSignals({}, robotsLines), terms_url: null, payment: noPayment, probe_status: null, verdict: stop(failure, failure.detail) });
    }
  }
  let exchange: HttpExchange;
  try {
    exchange = await options.probe(url.href, options.signal);
  } catch (error) {
    options.signal.throwIfAborted();
    const failure = classifyTransportError(error);
    return finish({ signals: detectAccessSignals({}, robotsLines), terms_url: null, payment: noPayment, probe_status: null, verdict: stop(failure, failure.detail) });
  }
  const refused = classifyExchange(exchange, { requestUrl: url.href });
  await options.pacer?.report(url.href, { status: exchange.status, retryAfter: exchange.headers['retry-after'] ?? null, failureClass: refused?.failure_class ?? null }).catch(() => undefined);
  const signals = detectAccessSignals(exchange.headers, robotsLines);
  if (exchange.status === 402) {
    const offer = parsePaymentOffer(exchange.headers);
    const failure: ExecFailure = { failure_class: 'payment_required', retryable: false, detail: 'http_402', status: 402 };
    return finish({ signals, terms_url: null, payment: { required: true, offer: offer.display }, probe_status: 402, verdict: stop(failure, ACCESS_MESSAGES.payment_required(offer.display)) });
  }
  const page = refused === null ? readPage(exchange) : { terms: null, feeds: [], officialApi: null };
  // Refus qui arrête (défi, 403, connexion requise) : l'enquête s'arrête là, sans autre requête (INV6).
  const route = refused === null ? null : failureRoute(refused.failure_class);
  if (refused !== null && route !== null && (route.next === 'stop' || route.next === 'action_required')) {
    return finish({ signals, terms_url: null, payment: noPayment, probe_status: exchange.status, verdict: stop(refused, refused.detail) });
  }
  let llms = false;
  if (options.probeLlmsTxt !== false) {
    const llmsUrl = `${url.origin}/llms.txt`;
    const allowed = await options.gate.check(llmsUrl);
    const slot = allowed.allowed ? ((await options.pacer?.acquire(llmsUrl)) ?? { granted: true as const }) : { granted: false as const };
    if (allowed.allowed && slot.granted) {
      try {
        const res = await options.probe(llmsUrl, options.signal);
        await options.pacer?.report(llmsUrl, { status: res.status, retryAfter: res.headers['retry-after'] ?? null, failureClass: null }).catch(() => undefined);
        llms = res.status >= 200 && res.status < 300 && !/html/i.test(res.headers['content-type'] ?? '') && res.body.trim() !== '';
      } catch {
        options.signal.throwIfAborted();
        llms = false;
      }
    }
  }
  return finish({ signals, terms_url: page.terms, payment: noPayment, probe_status: exchange.status, verdict: { proceed: true }, feeds: page.feeds, officialApi: page.officialApi, llms });
}

/** Sonde par une session réseau (contrôle robots à chaque saut, User-Agent du robot), corps borné. */
export function sessionAccessProbe(session: Pick<NetworkSession, 'fetch'>, maxBytes = ACCESS_PROBE_MAX_BYTES): AccessProbe {
  return async (url, signal) => {
    const response = await session.fetch(url, { method: 'GET', headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' }, signal });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const reader = (response.body as ReadableStream<Uint8Array> | null)?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader !== undefined) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > maxBytes) {
          chunks.push(value.subarray(0, maxBytes - size));
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
        size += value.byteLength;
      }
    }
    return { status: response.status, headers, body: Buffer.concat(chunks).toString('utf8'), url: response.url === '' ? url : response.url };
  };
}

/** Pastille Accès du catalogue (OpenAPI `AccessReport.signal`). */
export function accessSignalOf(report: AccessReport): 'allowed' | 'review' | 'disallowed' {
  if (report.robots.status === 'disallowed') return 'disallowed';
  if (!report.verdict.proceed || report.signals.length > 0 || report.payment.required) return 'review';
  return 'allowed';
}

/** Vue publique (OpenAPI `AccessReport`, onglet « Accès ») : lecture seule. */
export function accessReportView(report: AccessReport): {
  id: string;
  checked_at: string;
  signal: 'allowed' | 'review' | 'disallowed';
  robots: { status: RobotsReportStatus; fetched_at: string | null; rule: string | null };
  usage_signals: { kind: string; value: string }[];
  llms_txt: boolean;
  payment_offer: string | null;
  official_api_url: string | null;
} {
  return {
    id: report.id,
    checked_at: report.checked_at,
    signal: accessSignalOf(report),
    robots: { status: report.robots.status, fetched_at: report.robots.fetched_at, rule: report.robots.rule },
    usage_signals: report.signals.map((s) => ({ kind: s.kind, value: s.value })),
    llms_txt: report.declared.llms_txt,
    payment_offer: report.payment.offer,
    official_api_url: report.declared.official_api_url,
  };
}

/**
 * Charge de l'événement `access_report` (`investigation_events`) : le rapport complet, sans le corps de la page. C'est
 * la première ligne du journal en direct et la source de l'objet `access` des résultats.
 */
export function accessReportEventPayload(report: AccessReport): Record<string, unknown> {
  return { ...report, view: accessReportView(report) };
}

/**
 * Faits du rapport qu'un prompt peut recevoir (enquête, réparation) : des booléens et des codes, JAMAIS la valeur d'un
 * signal, d'un lien de CGU ou d'un texte du site (un signal est une donnée, pas une consigne).
 */
export function accessFactsForPrompt(report: AccessReport): {
  robots: RobotsReportStatus;
  proceed: boolean;
  payment_required: boolean;
  official_api_declared: boolean;
  feeds_declared: number;
  llms_txt: boolean;
  usage_signals_present: boolean;
} {
  return {
    robots: report.robots.status,
    proceed: report.verdict.proceed,
    payment_required: report.payment.required,
    official_api_declared: report.declared.official_api_url !== null,
    feeds_declared: report.declared.feeds.length,
    llms_txt: report.declared.llms_txt,
    usage_signals_present: report.signals.length > 0,
  };
}
