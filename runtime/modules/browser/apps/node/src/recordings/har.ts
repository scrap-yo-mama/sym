// SPDX-License-Identifier: AGPL-3.0-only
// HAR 1.2 construit par le nœud depuis les événements réseau du contexte de la session (04d § 2.1, 04f § 5), le même pour
// une session shared (Playwright natif) et une session dedicated pilotée en CDP : `recordHar` de Playwright ne s'applique
// qu'à un contexte créé avec l'option, ce qui exclut le contexte par défaut d'un Chromium dédié. Mode minimal, sans corps.
// En-têtes et cookies sensibles masqués, paramètres de query sensibles remplacés (même liste que les journaux de 0.3).
import { REDACTED } from '@sym-browser/core';
import { maskJsonLine } from './sanitize.js';

export type HarInput = {
  startedAt: Date;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  status: number;
  statusText: string;
  responseHeaders: Record<string, string>;
  mimeType: string;
  /** Octets du corps de la réponse (0 si inconnu). */
  bodySize: number;
  timings: { send: number; wait: number; receive: number };
  failure?: string;
};

/** Noms de paramètres sensibles : même règle que `redactUrl` de `@sym-browser/core` (sous-chaînes, et `t`). */
const SENSITIVE_PARAM = /secret|token|key|pass|sig|auth|cred|session|cookie/i;
const isSensitive = (name: string): boolean => name.toLowerCase() === 't' || SENSITIVE_PARAM.test(name);

const headerList = (headers: Record<string, string>) => Object.entries(headers).map(([name, value]) => ({ name, value }));
const ms = (value: number): number => Math.max(0, Math.round(value * 1000) / 1000);

function queryString(url: string): { name: string; value: string }[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value: isSensitive(name) ? REDACTED : value }));
  } catch {
    return [];
  }
}

export class HarBuilder {
  readonly #creator: { name: string; version: string };
  readonly #entries: string[] = [];
  readonly #maxBytes: number;
  #bytes = 0;
  truncated = false;

  constructor(creator: { name: string; version: string }, maxBytes = Number.POSITIVE_INFINITY) {
    this.#creator = creator;
    this.#maxBytes = maxBytes;
  }

  get size(): number {
    return this.#entries.length;
  }

  add(input: HarInput): boolean {
    if (this.truncated) return false;
    const timings = { send: ms(input.timings.send), wait: ms(input.timings.wait), receive: ms(input.timings.receive) };
    const entry = {
      startedDateTime: input.startedAt.toISOString(),
      time: ms(timings.send + timings.wait + timings.receive),
      request: { method: input.method, url: input.url, httpVersion: 'HTTP/1.1', cookies: [], headers: headerList(input.requestHeaders), queryString: queryString(input.url), headersSize: -1, bodySize: -1 },
      response: {
        status: input.status,
        statusText: input.statusText,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: headerList(input.responseHeaders),
        content: { size: input.bodySize, mimeType: input.mimeType },
        redirectURL: input.responseHeaders['location'] ?? '',
        headersSize: -1,
        bodySize: input.bodySize,
      },
      cache: {},
      timings,
      ...(input.failure === undefined ? {} : { _failureText: input.failure }),
    };
    const text = maskJsonLine(JSON.stringify(entry));
    if (this.#bytes + text.length + 1 > this.#maxBytes) {
      this.truncated = true;
      return false;
    }
    this.#entries.push(text);
    this.#bytes += text.length + 1;
    return true;
  }

  serialize(): string {
    return `{"log":{"version":"1.2","creator":${JSON.stringify(this.#creator)},"pages":[],"entries":[${this.#entries.join(',')}]}}`;
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Contrôle de forme HAR 1.2 (champs obligatoires de la spécification) ; rend la liste des problèmes. */
export function validateHar(har: unknown): string[] {
  const problems: string[] = [];
  if (!isObj(har) || !isObj(har['log'])) return ['log absent'];
  const log = har['log'];
  if (!isStr(log['version'])) problems.push('log.version absent');
  if (!isObj(log['creator']) || !isStr(log['creator']['name']) || !isStr(log['creator']['version'])) problems.push('log.creator incomplet');
  if (!Array.isArray(log['entries'])) return [...problems, 'log.entries absent'];
  log['entries'].forEach((entry: unknown, i: number) => {
    const at = `entries[${i}]`;
    if (!isObj(entry)) return void problems.push(`${at} invalide`);
    if (!isStr(entry['startedDateTime']) || Number.isNaN(Date.parse(entry['startedDateTime']))) problems.push(`${at}.startedDateTime invalide`);
    if (!isNum(entry['time']) || entry['time'] < 0) problems.push(`${at}.time invalide`);
    const request = entry['request'];
    if (!isObj(request) || !isStr(request['method']) || !isStr(request['url']) || !isStr(request['httpVersion']) || !Array.isArray(request['cookies']) || !Array.isArray(request['headers']) || !Array.isArray(request['queryString']) || !isNum(request['headersSize']) || !isNum(request['bodySize'])) {
      problems.push(`${at}.request incomplet`);
    }
    const response = entry['response'];
    if (
      !isObj(response) ||
      !isNum(response['status']) ||
      !isStr(response['statusText']) ||
      !isStr(response['httpVersion']) ||
      !Array.isArray(response['cookies']) ||
      !Array.isArray(response['headers']) ||
      !isObj(response['content']) ||
      !isNum(response['content']['size']) ||
      !isStr(response['content']['mimeType']) ||
      !isStr(response['redirectURL']) ||
      !isNum(response['headersSize']) ||
      !isNum(response['bodySize'])
    ) {
      problems.push(`${at}.response incomplet`);
    }
    if (!isObj(entry['cache'])) problems.push(`${at}.cache absent`);
    const timings = entry['timings'];
    if (!isObj(timings) || !isNum(timings['send']) || !isNum(timings['wait']) || !isNum(timings['receive'])) problems.push(`${at}.timings incomplet`);
  });
  return problems;
}
