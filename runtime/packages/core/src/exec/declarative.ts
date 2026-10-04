// SPDX-License-Identifier: AGPL-3.0-only
// Boucle d'exécution d'une stratégie déclarative (tâche 1.6 ; 04b §2) commune à E1, E2 et E3 : étapes préalables,
// requête modèle, pagination, extraction validée contre `output_schema` (INV1), cadence par domaine avant chaque
// requête (1.9), plafond de requêtes par run. Seul le transport change d'un exécuteur à l'autre. Aucun `eval` :
// l'interpréteur de 1.1b fait toute l'extraction ; une réponse refusée (classe d'échec) n'est jamais extraite.
import { parseHtml } from '../dsl/css.js';
import { findNextHref } from '../dsl/next-link.js';
import { DslError } from '../dsl/errors.js';
import { extractRecords, type ItemPolicy } from '../dsl/extract.js';
import { queryValues } from '../dsl/jsonpath.js';
import { parseJsonBounded, resolveLimits, type DslLimits } from '../dsl/limits.js';
import { advancePagination, initialParam, resolveNextUrl, ScrollTracker, startPagination, type StopReason } from '../dsl/pagination.js';
import type { DeclarativeSpec } from '../dsl/spec.js';
import { renderRequest, type RenderedRequest, type TemplateContext } from '../dsl/template.js';
import { classifyExchange, classifyTransportError, TransportRefusal, type ClassifyContext } from './classify.js';
import { applyParamAt, applyPathPattern } from './params.js';
import type { ExecFailure, HttpExchange, RequestPacer, ScrollTransport, Transport } from './types.js';

export type DeclarativeRunOptions = {
  readonly spec: DeclarativeSpec;
  readonly input: unknown;
  /** `output_schema` d'un enregistrement : chaque page est validée (INV1). */
  readonly outputSchema?: unknown;
  /** Politique des items non conformes (D-49) : `strict` (défaut, enquête) ou `quarantine` (runs). */
  readonly itemPolicy?: ItemPolicy;
  readonly transport: Transport;
  readonly signal: AbortSignal;
  readonly pacer?: RequestPacer;
  /** `domain_pacing.max_requests_per_run` : au-delà, la pagination s'arrête (sortie tronquée, run dégradé). */
  readonly maxRequests?: number;
  /** Garde de classification avant extraction (1.7). Défaut : `classifyExchange` (statut, en-têtes, défi, redirection). */
  readonly classify?: (exchange: HttpExchange, context?: ClassifyContext) => ExecFailure | null;
  readonly limits?: Partial<DslLimits>;
  /**
   * Suite d'une pagination `infinite_scroll` : fait défiler la page déjà chargée par le transport (E3) et rend son DOM
   * à jour. Absent (E1, E2 : pas de page à faire défiler), la pagination s'arrête après la première page (`unsupported`).
   * Chaque défilement passe par le contrôle d'accès, la cadence et la garde de classification comme une requête.
   */
  readonly scroll?: ScrollTransport;
};

export type DeclarativeStop = StopReason | 'max_requests_per_run' | 'max_items';

export type DeclarativeRunResult =
  | {
      readonly ok: true;
      readonly records: Record<string, unknown>[];
      readonly pages: number;
      readonly requests: number;
      /** Une source de repli a servi (signal `escalated`, 04b §2). */
      readonly escalated: boolean;
      readonly stop: DeclarativeStop;
      /** Arrêt imposé par un plafond (requêtes par run, items) avant la fin naturelle de la pagination. */
      readonly truncated: boolean;
      /**
       * Échange d'une page dont des enregistrements ont été écartés (sinon la dernière page), corps borné : preuve remise à
       * la garde quand la casse vient du seuil des items non conformes (D-49), pour le squelette du rôle `repair` (04 §5
       * étape 1). Jamais écrite (ni run, ni journal).
       */
      readonly evidence?: HttpExchange;
    }
  | {
      readonly ok: false;
      readonly failure: ExecFailure;
      readonly pages: number;
      readonly requests: number;
      /**
       * Échange qui a échoué (refus classé, extraction impossible), corps borné à `EVIDENCE_MAX_CHARS` : preuve remise à
       * la garde avant réparation (1.7, `invokeAgentGuarded`), jamais écrite (ni run, ni journal). Absent pour une
       * erreur de transport.
       */
      readonly evidence?: HttpExchange;
    };

/**
 * Borne du corps d'une preuve : la lecture de la détection (256 Kio) plus un caractère, pour qu'un très gros document
 * reste « au-delà de la borne » (seul son titre est lu) une fois tronqué.
 */
export const EVIDENCE_MAX_CHARS = 256 * 1024 + 1;

/** Preuve bornée d'un échange (corps tronqué). */
export function boundedEvidence(exchange: HttpExchange): HttpExchange {
  return exchange.body.length <= EVIDENCE_MAX_CHARS ? exchange : { ...exchange, body: exchange.body.slice(0, EVIDENCE_MAX_CHARS) };
}

class RunFailure extends Error {
  readonly failure: ExecFailure;
  constructor(failure: ExecFailure) {
    super(failure.detail);
    this.failure = failure;
  }
}

class RequestCapReached extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function tryParseJson(body: string, limits: DslLimits): unknown {
  const head = body.trimStart()[0];
  if (head !== '{' && head !== '[') return undefined;
  try {
    return parseJsonBounded(body, limits);
  } catch {
    return undefined;
  }
}

/** Lien « suivant » d'une page HTML (`<link rel="next">` ou `<a rel="next">`), rendu comme un en-tête `Link`. */
function htmlNextLink(body: string, limits: DslLimits): string | undefined {
  try {
    const doc = parseHtml(body, limits);
    // `rel=next` d'abord, puis le lien « suivant » reconnu par libellé, flèche ou classe (banc réel R07 : `li.next > a`,
    // relatif, sans rel) : même règle qu'à la reconnaissance. L'URL est résolue puis vérifiée (hôte) par l'appelant.
    const href = findNextHref(doc);
    return href === undefined || href === '' ? undefined : `<${href}>; rel="next"`;
  } catch {
    return undefined;
  }
}

function maxPagesFromInput(spec: DeclarativeSpec, input: Record<string, unknown>): number | undefined {
  const ref = spec.pagination?.limits?.max_pages_input;
  if (ref === undefined || !ref.startsWith('input.')) return undefined;
  const value = input[ref.slice('input.'.length)];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** Exécute la stratégie : renvoie les enregistrements conformes, ou la classe d'échec du premier refus. */
export async function runDeclarative(options: DeclarativeRunOptions): Promise<DeclarativeRunResult> {
  const { spec, transport, signal, pacer } = options;
  const classify = options.classify ?? classifyExchange;
  const limits = resolveLimits(spec.limits, options.limits);
  const input = isRecord(options.input) ? options.input : {};
  const allowed = spec.request.allowed_hosts;
  const ctx: TemplateContext = { input, page: {}, steps: {} };
  let requests = 0;
  let pages = 0;
  /** Dernier échange reçu (preuve d'un échec) ; remis à zéro avant chaque requête. */
  let last: HttpExchange | undefined;
  const failed = (failure: ExecFailure): DeclarativeRunResult => ({ ok: false, failure, pages, requests, ...(last === undefined ? {} : { evidence: boundedEvidence(last) }) });

  const send = async (request: RenderedRequest, via: Transport = transport): Promise<HttpExchange> => {
    last = undefined;
    if (options.maxRequests !== undefined && requests >= options.maxRequests) throw new RequestCapReached();
    signal.throwIfAborted();
    if (pacer !== undefined) {
      const slot = await pacer.acquire(request.url);
      if (!slot.granted) throw new RunFailure({ failure_class: 'rate_limited', retryable: true, detail: `pacing_${slot.reason}` });
    }
    requests += 1;
    let exchange: HttpExchange;
    try {
      exchange = await via(request, signal);
      last = exchange;
    } catch (error) {
      if (signal.aborted) throw error;
      // Refus décidé par le transport (navigation lancée par la page, 1.7) : compté pour le disjoncteur comme tout refus.
      if (error instanceof TransportRefusal) {
        last = error.exchange;
        await pacer?.report(request.url, { status: error.failure.status ?? error.exchange?.status ?? 0, retryAfter: null, failureClass: error.failure.failure_class });
      }
      throw new RunFailure(classifyTransportError(error));
    }
    // Garde de classification AVANT extraction : une réponse refusée n'est jamais extraite (INV6). La classe est rapportée à
    // la cadence : un refus (403, défi en 200) compte pour le disjoncteur du domaine comme un 429 (04 §7).
    const refused = classify(exchange, { requestUrl: request.url });
    await pacer?.report(request.url, { status: exchange.status, retryAfter: exchange.headers['retry-after'] ?? null, failureClass: refused?.failure_class ?? null });
    if (refused !== null) throw new RunFailure(refused);
    return exchange;
  };

  try {
    for (const step of spec.steps ?? []) {
      const exchange = await send(renderRequest(step.request, allowed, ctx));
      let doc: unknown;
      try {
        doc = parseJsonBounded(exchange.body, limits);
      } catch (error) {
        throw new RunFailure({ failure_class: 'extraction', retryable: false, detail: error instanceof DslError ? `step_${error.code}` : 'step_invalid_json' });
      }
      const captured: Record<string, unknown> = {};
      for (const [name, path] of Object.entries(step.capture)) {
        const [value] = queryValues(path, doc, { limits });
        if (value === undefined) throw new RunFailure({ failure_class: 'extraction', retryable: false, detail: 'step_capture_missing' });
        Object.defineProperty(captured, name, { value, enumerable: true, writable: true, configurable: true });
      }
      Object.defineProperty(ctx.steps, step.id, { value: captured, enumerable: true, writable: true, configurable: true });
    }

    const pagination = spec.pagination;
    const state = startPagination();
    const maxPagesInput = maxPagesFromInput(spec, input);
    let param: { at: string; value: string | number } | undefined = pagination === undefined ? undefined : initialParam(pagination);
    let nextUrl: string | undefined;
    const records: Record<string, unknown>[] = [];
    let escalated = false;
    /** `infinite_scroll` : la prochaine « page » est un défilement de la page chargée, pas une requête de plus. */
    let scrolling = false;
    const scrollSeen = new ScrollTracker();
    /**
     * Pagination par paramètre (`page_param`, `offset`) : contenu de la page précédente. Une page identique à la précédente
     * veut dire que le site ignore le paramètre (pagination changée côté site) : casse `extraction` (réparation), jamais une
     * sortie pleine de doublons jusqu'au plafond dur rendue comme un succès (faux succès, 15 §11). Au-delà de la page 2, une
     * page déjà vue (site qui ramène une page hors liste à la dernière page ou à la première) est la FIN de la liste.
     */
    let previousPage: string | undefined;
    const seenPages = new Set<string>();
    /**
     * Liste HTML paginée : enregistrements déjà livrés (contenu identique) écartés ; une page qui n'apporte QUE des doublons
     * est la fin de la liste (banc réel R02 : les 6 dernières pages ne servent que 12 programmes répétés).
     */
    const htmlList = spec.sources.every((s) => s.from === 'html') && (pagination?.type === 'page_param' || pagination?.type === 'offset' || pagination?.type === 'next_link');
    const delivered = new Set<string>();
    const scrollVia: Transport | undefined = options.scroll === undefined ? undefined : (_request, sig) => options.scroll!(sig);
    /** Preuve d'une sortie réussie : première page aux enregistrements écartés, sinon la dernière page lue. */
    let rejectedPage: HttpExchange | undefined;
    let lastPage: HttpExchange | undefined;
    const done = (stop: DeclarativeStop, truncated: boolean): DeclarativeRunResult => {
      const proof = rejectedPage ?? lastPage;
      return { ok: true, records, pages, requests, escalated, stop, truncated, ...(proof === undefined ? {} : { evidence: boundedEvidence(proof) }) };
    };

    for (;;) {
      ctx.page = { number: state.pages + 1, offset: state.received, ...(param === undefined ? {} : { value: param.value }), ...(state.cursor === null ? {} : { cursor: state.cursor }) };
      let request = nextUrl === undefined ? renderRequest(spec.request, allowed, ctx) : { ...renderRequest(spec.request, allowed, ctx), method: 'GET' as const, url: nextUrl, body: undefined };
      if (nextUrl === undefined && param !== undefined) {
        request =
          param.at === 'url.path' && pagination?.path_pattern !== undefined
            ? applyPathPattern(request, pagination.path_pattern, param.value, pagination.start ?? 1)
            : applyParamAt(request, param.at, param.value);
      }
      if (request.body === undefined) delete (request as { body?: unknown }).body;

      let exchange: HttpExchange;
      try {
        exchange = await (scrolling && scrollVia !== undefined ? send(request, scrollVia) : send(request));
      } catch (error) {
        if (error instanceof RequestCapReached && pages > 0) return done('max_requests_per_run', true);
        // Page suivante absente (404, 410) après la première : fin de la liste, pas une casse (04b §2, règle d'arrêt).
        if (error instanceof RunFailure && error.failure.failure_class === 'not_found' && pages > 0 && (pagination?.type === 'page_param' || pagination?.type === 'offset' || pagination?.type === 'next_link')) {
          return done('no_next', false);
        }
        throw error;
      }
      pages += 1;
      lastPage = exchange;
      const out = extractRecords(spec, { body: exchange.body }, { ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }), ...(options.itemPolicy === undefined ? {} : { itemPolicy: options.itemPolicy }), limits });
      // Après la première page, une page vide marque la fin (`records_empty`), pas une casse.
      const emptyPage = !out.ok && pages > 1 && out.attempts.every((a) => a.records === 0 && a.problems.every((p) => p.code === 'no_records' || p.code === 'too_few_records'));
      if (!out.ok && !emptyPage) {
        const codes = out.attempts.flatMap((a) => a.problems.map((p) => p.code));
        const detail = codes.includes('schema_mismatch') ? 'schema_mismatch' : (codes[0] ?? 'no_records');
        return failed({ failure_class: 'extraction', retryable: false, detail });
      }
      // Le DOM d'un flux à défilement est cumulatif : seuls les enregistrements jamais vus sont de cette « page ».
      const got = out.ok ? (pagination?.type === 'infinite_scroll' ? scrollSeen.fresh(out.records) : out.records) : [];
      if ((pagination?.type === 'page_param' || pagination?.type === 'offset') && got.length > 0) {
        const content = JSON.stringify(got);
        if (content === previousPage && pages <= 2) return failed({ failure_class: 'extraction', retryable: false, detail: 'pagination_repeated_page' });
        if (seenPages.has(content)) return done('no_next', false);
        seenPages.add(content);
        previousPage = content;
      }
      escalated ||= out.ok && out.escalated;
      if (rejectedPage === undefined && out.ok && out.attempts[out.source_index]?.problems.some((p) => p.record !== null) === true) rejectedPage = exchange;
      if (htmlList && got.length > 0) {
        const fresh = got.filter((r) => {
          const key = JSON.stringify(r);
          if (delivered.has(key)) return false;
          delivered.add(key);
          return true;
        });
        if (fresh.length === 0 && pages > 1) return done('no_next', false);
        for (const r of fresh) records.push(r);
      } else for (const r of got) records.push(r);
      if (records.length >= limits.maxItems) {
        records.length = limits.maxItems;
        return done('max_items', true);
      }
      // Défilement expiré sans rien apporter, réseau encore occupé : ce n'est pas la fin du flux (site lent), la sortie est
      // tronquée et le signal `pagination_short` levé ; `scroll_timeout` ne compte pas parmi les fins naturelles (enquête).
      if (scrolling && exchange.scrollTimedOut === true && got.length === 0) return done('scroll_timeout', true);
      const document = tryParseJson(exchange.body, limits);
      const linkHeader = exchange.headers['link'] ?? (pagination?.type === 'next_link' && document === undefined ? htmlNextLink(exchange.body, limits) : undefined);
      const decision = advancePagination(
        pagination,
        state,
        { records: got.length, ...(document === undefined ? {} : { document }), ...(linkHeader === undefined ? {} : { linkHeader }) },
        { limits },
        maxPagesInput,
      );
      if (decision.done) return done(decision.reason, false);
      if (decision.scroll === true) {
        // Pas de page à faire défiler (E1, E2) : la liste n'est pas lue au-delà de la première page (sortie tronquée : signal
        // `pagination_short`, 04 §6).
        if (scrollVia === undefined) return done('unsupported', true);
        scrolling = true;
        nextUrl = undefined;
        continue;
      }
      if (decision.nextUrl !== undefined) {
        nextUrl = resolveNextUrl(decision.nextUrl, exchange.url, allowed);
      } else if (decision.param !== undefined) {
        param = decision.param;
        nextUrl = undefined;
      }
    }
  } catch (error) {
    if (error instanceof RunFailure) return failed(error.failure);
    if (error instanceof RequestCapReached) return { ok: false, failure: { failure_class: 'code_error', retryable: false, detail: 'max_requests_per_run' }, pages, requests };
    if (error instanceof DslError) return failed(classifyTransportError(error));
    throw error;
  }
}
