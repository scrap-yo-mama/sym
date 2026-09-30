// Cassettes msw pour le contrat du client LLM (15 §4) : `replay` strict par défaut (requête inconnue => échec),
// `record` seulement si LLM_CASSETTE_MODE=record, clé de correspondance normalisée (jamais le prompt brut),
// secrets purgés (en-têtes, valeurs de clé), cas synthétiques marqués et toujours rejoués.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bypass, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Secret } from '@runtime/core';

export type CassetteMode = 'replay' | 'record';

export function cassetteMode(env: NodeJS.ProcessEnv = process.env): CassetteMode {
  return env['LLM_CASSETTE_MODE'] === 'record' ? 'record' : 'replay';
}

interface CassetteEntry {
  /** Clé normalisée ; `*` (cas synthétiques écrits à la main) accepte toute requête du chemin. */
  key: string;
  request: { method: string; path: string; shape: Record<string, unknown> };
  response: { status: number; headers: Record<string, string>; body: string };
}

export interface CassetteFile {
  version: 1;
  provider: string;
  case: string;
  /** Écrit à la main (5xx, refus…) : jamais réenregistré, marqué comme tel. */
  synthetic: boolean;
  note?: string;
  entries: CassetteEntry[];
}

const KEPT_RESPONSE_HEADERS = /^(content-type|retry-after|retry-after-ms|x-ratelimit-[a-z-]+)$/i;
const SECRET_HEADER = /authorization|api-key|cookie|token/i;

const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canonical(x)])) : v;

/** Forme normalisée d'une requête : structure, pas contenu (aucun texte de prompt, aucun secret). */
export function requestShape(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body['messages']) ? (body['messages'] as { role?: string }[]) : [];
  const tools = Array.isArray(body['tools']) ? (body['tools'] as { function?: { name?: string } }[]) : [];
  const rf = body['response_format'] as { type?: string; json_schema?: { name?: string; strict?: boolean; schema?: unknown } } | undefined;
  const choice = body['tool_choice'];
  return {
    model: body['model'],
    stream: body['stream'] === true,
    roles: messages.map((m) => m.role),
    tools: tools.map((t) => t.function?.name).sort(),
    tool_choice: typeof choice === 'string' ? choice : (choice as { function?: { name?: string } } | undefined)?.function?.name ?? null,
    response_format:
      rf === undefined
        ? null
        : { type: rf.type, name: rf.json_schema?.name ?? null, strict: rf.json_schema?.strict ?? null, schema_sha: rf.json_schema ? sha(rf.json_schema.schema) : null },
    max_tokens: body['max_tokens'] ?? null,
    extra_params: Object.keys(body)
      .filter((k) => !['model', 'messages', 'stream', 'tools', 'tool_choice', 'response_format', 'max_tokens', 'stream_options'].includes(k))
      .sort(),
  };
}

const sha = (v: unknown): string => createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex').slice(0, 12);

export function requestKey(method: string, path: string, shape: Record<string, unknown>): string {
  return sha({ method, path, shape });
}

/** Retire toute valeur de secret connue d'un texte ; lève si `strict` et qu'une valeur est trouvée. */
export function scrub(text: string, secrets: string[], strict = false): string {
  let out = text;
  for (const s of secrets) {
    if (s.length < 8 || !out.includes(s)) continue;
    if (strict) throw new Error('cassette : une valeur de clé figure dans le contenu à enregistrer (enregistrement annulé)');
    out = out.split(s).join('[REDACTED]');
  }
  return out;
}

export interface ProviderFixture {
  id: 'deepinfra' | 'openrouter';
  baseUrl: string;
  apiKey: Secret;
  model: string;
  extraBody?: Record<string, unknown>;
}

const DEFAULT_BASE = {
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  openrouter: 'https://openrouter.ai/api/v1',
} as const;

/** Modèles P0. OpenRouter : GLM 5.3 flash, appel d'outils et structured_outputs, ~0,15 $ / 0,50 $ le million (relevé 2026-10-01). */
const P0_MODELS = { deepinfra: 'zai-org/GLM-5.3', openrouter: 'z-ai/glm-5.3-flash' } as const;

export function providerFixture(id: ProviderFixture['id'], env: NodeJS.ProcessEnv = process.env): ProviderFixture {
  const record = cassetteMode(env) === 'record';
  const keyVar = id === 'deepinfra' ? 'DEEPINFRA_API_KEY' : 'OPENROUTER_API_KEY';
  const baseVar = id === 'deepinfra' ? 'DEEPINFRA_BASE_URL' : 'OPENROUTER_BASE_URL';
  const key = record ? env[keyVar] : undefined;
  if (record && (key === undefined || key === '')) throw new Error(`record : ${keyVar} absente de l'environnement`);
  return {
    id,
    baseUrl: (record ? env[baseVar] : undefined) ?? DEFAULT_BASE[id],
    apiKey: new Secret(key ?? 'replay-placeholder-not-a-key'),
    model: P0_MODELS[id],
    ...(id === 'openrouter' ? { extraBody: { provider: { require_parameters: true } } } : {}),
  };
}

export function secretValuesFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return ['DEEPINFRA_API_KEY', 'OPENROUTER_API_KEY'].map((k) => env[k]).filter((v): v is string => typeof v === 'string' && v !== '');
}

interface Active {
  name: string;
  file: string;
  mode: CassetteMode;
  data: CassetteFile;
  used: Map<string, number>;
  recorded: CassetteEntry[];
  misses: string[];
  provider: string;
  synthetic: boolean;
}

export interface CassetteKit {
  start(): void;
  stop(): void;
  /** Sélectionne la cassette `<provider>/<case>.json`. `synthetic` : écrite à la main, toujours rejouée. */
  use(provider: string, caseName: string, opts?: { synthetic?: boolean }): void;
  /** Vérifie (replay) que tout est consommé et que rien n'est inconnu ; écrit (record). */
  finish(): void;
  readonly mode: CassetteMode;
}

export function createCassetteKit(dir: string, env: NodeJS.ProcessEnv = process.env): CassetteKit {
  const mode = cassetteMode(env);
  const secrets = secretValuesFromEnv(env);
  let active: Active | undefined;

  const server = setupServer(
    http.post('*/chat/completions', async ({ request }) => {
      if (active === undefined) throw new Error('cassette : aucune cassette sélectionnée (appeler use())');
      const a = active;
      const path = new URL(request.url).pathname;
      const bodyText = await request.clone().text();
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        /* corps non JSON : forme vide */
      }
      const shape = requestShape(body);
      const key = requestKey(request.method, path, shape);

      if (a.mode === 'record') {
        const real = await fetch(bypass(request));
        const text = await real.clone().text();
        const headers: Record<string, string> = {};
        real.headers.forEach((value, name) => {
          if (KEPT_RESPONSE_HEADERS.test(name) && !SECRET_HEADER.test(name)) headers[name] = value;
        });
        a.recorded.push({
          key,
          request: { method: request.method, path, shape },
          response: { status: real.status, headers, body: scrub(text, secrets, true) },
        });
        return new HttpResponse(text, { status: real.status, headers });
      }

      const candidates = a.data.entries.filter((e) => e.key === key || e.key === '*');
      const exact = a.data.entries.filter((e) => e.key === key);
      const pool = exact.length > 0 ? exact : candidates;
      const tally = `${exact.length > 0 ? key : '*'}`;
      const n = a.used.get(tally) ?? 0;
      const entry = pool[n];
      if (entry === undefined) {
        a.misses.push(`${request.method} ${path} clé ${key} (occurrence ${n + 1}) absente de ${a.name}`);
        return HttpResponse.json({ error: { message: 'cassette: requête inconnue (replay strict)' } }, { status: 599 });
      }
      a.used.set(tally, n + 1);
      return new HttpResponse(entry.response.body, { status: entry.response.status, headers: entry.response.headers });
    }),
  );

  return {
    mode,
    start: () => server.listen({ onUnhandledRequest: 'error' }),
    stop: () => server.close(),
    use(provider, caseName, opts = {}) {
      const file = join(dir, provider, `${caseName}.json`);
      const synthetic = opts.synthetic === true;
      const effective: CassetteMode = synthetic ? 'replay' : mode;
      let data: CassetteFile = { version: 1, provider, case: caseName, synthetic, entries: [] };
      if (effective === 'replay') {
        if (!existsSync(file)) throw new Error(`cassette absente : ${file} (enregistrer avec LLM_CASSETTE_MODE=record)`);
        data = JSON.parse(readFileSync(file, 'utf8')) as CassetteFile;
        if (data.synthetic !== synthetic) throw new Error(`cassette ${file} : drapeau synthetic incohérent avec le test`);
      }
      active = { name: `${provider}/${caseName}`, file, mode: effective, data, used: new Map(), recorded: [], misses: [], provider, synthetic };
    },
    finish() {
      const a = active;
      active = undefined;
      if (a === undefined) return;
      if (a.mode === 'record') {
        const out: CassetteFile = { version: 1, provider: a.provider, case: a.data.case, synthetic: false, entries: a.recorded };
        const text = JSON.stringify(out, null, 2);
        scrub(text, secrets, true);
        mkdirSync(dirname(a.file), { recursive: true });
        writeFileSync(a.file, `${text}\n`);
        return;
      }
      if (a.misses.length > 0) throw new Error(`cassette ${a.name} : requête(s) inconnue(s) en replay strict\n${a.misses.join('\n')}`);
      const consumed = [...a.used.values()].reduce((x, y) => x + y, 0);
      if (consumed !== a.data.entries.length) throw new Error(`cassette ${a.name} : ${a.data.entries.length - consumed} entrée(s) non rejouée(s)`);
    },
  };
}
