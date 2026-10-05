// SPDX-License-Identifier: AGPL-3.0-only
// Événements et audit en `{code, params}`, rendus À LA LECTURE dans la langue du lecteur (21 § 3, 21b § 1, M5). Les lignes de
// `investigation_events` portent le code (`kind`) et ses paramètres (la charge) ; jamais une phrase. Le récit de la console
// (déjà rendu côté client) et celui du MCP (rendu ici) dérivent des mêmes lignes.
import { flatten, namespaceOf, type Catalog } from './catalog.js';
import { fmtDuration, fmtUsd } from './format.js';
import { UNKNOWN_CODE_KEY, type Renderer } from './render.js';

export interface NarrativeEvent {
  readonly kind: string;
  readonly payload?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const asString = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const asNumber = (value: unknown, fallback = 0): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);

/** Clé du catalogue d'un type d'événement : `attempt.finished` → `narrative.attempt_finished`. */
export function narrativeKey(kind: string): string {
  return `narrative.${kind.replace(/\./g, '_')}`;
}

/** Une ligne du récit dans la langue du lecteur ; `null` pour un événement sans ligne de récit (clé en omission). */
export function narrativeLine(renderer: Renderer, event: NarrativeEvent, locale: string): string | null {
  const p = asRecord(event.payload);
  const money = (usd: unknown) => fmtUsd(asNumber(usd), locale);
  const time = (ms: unknown) => fmtDuration(asNumber(ms), locale);
  switch (event.kind) {
    case 'investigation.started':
      return renderer.render(narrativeKey(event.kind), { domain: asString(p.domain) }, locale);
    case 'phase.started': {
      const phase = asString(p.phase);
      const key = `narrative.phase.${phase}`;
      return renderer.has(key, 'en') ? renderer.render(key, {}, locale) : renderer.render('narrative.phase_started', { phase }, locale);
    }
    case 'access_report': {
      // D-91 : le rapport ne lit plus robots.txt. Refus du site (verdict) → arrêt ; signaux d'usage → « à lire » ; sinon sondée.
      const proceed = asRecord(p.verdict).proceed;
      const signal = asString(asRecord(p.view).signal);
      const outcome = proceed === false ? 'stopped' : proceed === true ? (signal === 'review' ? 'review' : 'proceed') : 'unknown';
      const key = `narrative.access_report.${outcome}`;
      const line = renderer.render(key, { duration: time(p.ms ?? p.duration_ms), cost: money(p.cost_usd) }, locale);
      // URL de départ redirigée de façon permanente vers un autre site (banc R09) : le domaine adopté est dit d'abord.
      if (typeof p.redirected_from !== 'string' || p.redirected_from === '') return line;
      let from = p.redirected_from;
      try {
        from = new URL(p.redirected_from).hostname;
      } catch {
        // origine illisible : rendue telle quelle
      }
      return `${renderer.render('narrative.access_report.redirected', { from, domain: asString(p.domain) }, locale)} ${line}`;
    }
    case 'reconnaissance.finished': {
      const n = Array.isArray(p.candidates) ? p.candidates.length : 0;
      return renderer.render(narrativeKey(event.kind), { n }, locale);
    }
    case 'schema.proposed': {
      const fields = Object.keys(asRecord(asRecord(p.output_schema).properties)).length;
      return p.ok === false ? null : renderer.render(narrativeKey(event.kind), { fields }, locale);
    }
    case 'schema.validated':
      return renderer.render(narrativeKey(event.kind), { by: asString(p.by, 'user') }, locale);
    case 'attempt.finished': {
      const a = asRecord(p.attempt);
      return renderer.render(narrativeKey(event.kind), { execution: asString(a.execution), network: asString(a.network), result: asString(a.result), duration: time(a.ms), cost: money(a.cost_usd) }, locale);
    }
    case 'attempt.pruned':
      return renderer.render(narrativeKey(event.kind), { n: Array.isArray(p.pruned) ? p.pruned.length : 0 }, locale);
    case 'status.changed':
      return renderer.render(narrativeKey(event.kind), { status: asString(p.status) }, locale);
    case 'action.required':
      return renderer.render(narrativeKey(event.kind), { domain: asString(p.domain), cause: asString(p.cause) }, locale);
    case 'investigation.finished':
      return renderer.render(narrativeKey(event.kind), { outcome: asString(p.outcome) }, locale);
    default:
      return renderer.render(UNKNOWN_CODE_KEY, { code: event.kind }, locale);
  }
}

/** Récit complet, une ligne par événement qui en a une. */
export function renderNarrative(renderer: Renderer, events: readonly NarrativeEvent[], locale: string): string[] {
  const lines: string[] = [];
  for (const event of events) {
    const line = narrativeLine(renderer, event, locale);
    if (line !== null) lines.push(line);
  }
  return lines;
}

const SENTENCE_NAMESPACES = new Set(['narrative', 'srv', 'email', 'mcp.user', 'reason']);

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Détecteur de phrase rendue : vrai si un texte est (ou contient) un message du catalogue, variables comprises. Un message
 * compte à partir de 3 mots et 16 caractères (un code court comme `blocked` n'est jamais une phrase).
 */
export function sentenceMatcher(catalogs: Readonly<Record<string, Catalog>>): (text: string) => boolean {
  const patterns: RegExp[] = [];
  for (const tree of Object.values(catalogs)) {
    for (const [key, message] of flatten(tree)) {
      if (!SENTENCE_NAMESPACES.has(namespaceOf(key))) continue;
      for (const form of message.split(' | ')) {
        const fixed = form.replace(/\{[^{}]*\}|@(?:\.\w+)?:[\w.]+/g, '').trim();
        if (fixed.length < 16 || fixed.split(/\s+/).length < 3) continue;
        const source = form
          .split(/(\{[^{}]*\}|@(?:\.\w+)?:[\w.]+)/)
          .map((part, i) => (i % 2 === 1 ? '.{0,200}?' : escapeRegex(part)))
          .join('');
        patterns.push(new RegExp(source, 'i'));
      }
    }
  }
  return (text) => text.length >= 16 && patterns.some((re) => re.test(text));
}

/**
 * Champs d'une charge qui portent des DONNÉES collectées sur un site (échantillon, schéma proposé, signaux d'accès, offre de
 * paiement, liens et règles lus sur le site), jamais une phrase produite par le code. La garde « codes seulement » ne les
 * contrôle pas : un texte de site peut ressembler à un message du catalogue (« Too many attempts, try again later. » sur une
 * FAQ) sans être une phrase rendue, et une donnée ne se traduit ni ne se refuse (21 § 6).
 */
export const COLLECTED_DATA_FIELDS: ReadonlySet<string> = new Set([
  'sample',
  'samples',
  'items',
  'records',
  'output_schema',
  'proposed_schema',
  'signals',
  'usage_signals',
  'payment',
  'payment_offer',
  'declared',
  'terms_url',
  'official_api_url',
  'rule',
  'url',
]);

/**
 * Chemins des valeurs de `payload` qui sont des phrases du catalogue (liste vide : codes et paramètres seulement). `skip` : noms de
 * champs dont la valeur entière (sous-arbre compris) est une donnée collectée, jamais contrôlée (`COLLECTED_DATA_FIELDS`).
 */
export function findRenderedSentences(payload: unknown, matches: (text: string) => boolean, options: { readonly skip?: ReadonlySet<string> } = {}): string[] {
  const skip = options.skip;
  const walk = (value: unknown, path: string): string[] => {
    if (typeof value === 'string') return matches(value) ? [path] : [];
    if (Array.isArray(value)) return value.flatMap((v, i) => walk(v, `${path}[${i}]`));
    if (typeof value === 'object' && value !== null) {
      return Object.entries(value).flatMap(([k, v]) => (skip?.has(k) === true ? [] : walk(v, `${path}.${k}`)));
    }
    return [];
  };
  return walk(payload, '$');
}

/** Clés d'un contrat d'événement sortant (webhook) qui ne doivent jamais exister : une phrase n'y a pas sa place (M10). */
export const FORBIDDEN_SENTENCE_FIELDS = ['message', 'text', 'description'] as const;
