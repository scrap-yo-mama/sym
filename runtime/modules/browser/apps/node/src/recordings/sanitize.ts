// SPDX-License-Identifier: AGPL-3.0-only
// Masquage des enregistrements (04d § 2.1 ; BINV6, couches de 0.3 reprises de `@sym-browser/core`) : en-têtes
// `Authorization`, `Cookie`, `Set-Cookie`, `Proxy-Authorization` et cookies HAR masqués, valeurs des paramètres sensibles
// remplacées, `Bearer …` et identifiants d'URL masqués, puis balayage des valeurs secrètes connues du processus.
// Journaux : une ligne JSON par événement, URL sans query ni identifiants. Trace : chaque ligne JSON de `*.trace` et
// `*.network` réécrite ; les ressources binaires (captures, corps) ne sont pas touchées.
import { closeSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { redactArtifactText, redactPatterns, secretValues } from '@sym-browser/core';
import { readZip, writeZip } from './zip.js';

/** Masquage d'un texte libre (message de console, motif d'échec). */
export const maskText = (text: string): string => redactPatterns(secretValues.redactText(text));

/** URL sans query, fragment ni identifiants ; texte masqué si ce n'est pas une URL. */
export function urlWithoutQuery(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return maskText(raw);
  }
}

export type ConsoleEntry = { ts: number; type: string; text: string; url: string };
export type NetworkEntry = { ts: number; method: string; url: string; status: number; durationMs: number; bytes: number; failure?: string };

export function consoleLine(entry: ConsoleEntry): string {
  return JSON.stringify({ ts: entry.ts, type: entry.type, text: maskText(entry.text), url: urlWithoutQuery(entry.url) });
}

export function networkLine(entry: NetworkEntry): string {
  return JSON.stringify({
    ts: entry.ts,
    method: entry.method,
    url: urlWithoutQuery(entry.url),
    status: entry.status,
    durationMs: Math.max(0, Math.round(entry.durationMs)),
    bytes: entry.bytes,
    ...(entry.failure === undefined ? {} : { failure: maskText(entry.failure) }),
  });
}

/** Ligne JSON d'un artefact : structure HAR masquée (en-têtes, cookies, corps postés), puis motifs et valeurs connues. */
export const maskJsonLine = (line: string): string => (line.trim() === '' ? line : redactPatterns(redactArtifactText(line)));

/** Trace Playwright réécrite sur place, lignes de `*.trace` et `*.network` masquées. */
export function sanitizeTraceZip(path: string): void {
  const entries = readZip(readFileSync(path));
  const out: [string, Buffer][] = [];
  for (const [name, data] of entries) {
    if (/\.(trace|network)$/.test(name)) out.push([name, Buffer.from(data.toString('utf8').split('\n').map(maskJsonLine).join('\n'))]);
    else out.push([name, data]);
  }
  writeFileSync(path, writeZip(out), { mode: 0o600 });
}

/** Journal NDJSON borné (`SYMB_RECORDING_MAX_BYTES`) : au franchissement, l'écriture s'arrête et `truncated` passe à vrai. */
export class LimitedLog {
  readonly path: string;
  readonly #fd: number;
  readonly #maxBytes: number;
  #bytes = 0;
  #closed = false;
  truncated = false;
  lines = 0;

  constructor(path: string, maxBytes: number) {
    this.path = path;
    this.#maxBytes = maxBytes;
    this.#fd = openSync(path, 'w', 0o600);
  }

  write(line: string): boolean {
    if (this.#closed || this.truncated) return false;
    const data = `${line}\n`;
    const size = Buffer.byteLength(data);
    if (this.#bytes + size > this.#maxBytes) {
      this.truncated = true;
      return false;
    }
    writeSync(this.#fd, data);
    this.#bytes += size;
    this.lines += 1;
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    closeSync(this.#fd);
  }
}
