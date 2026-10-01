// SPDX-License-Identifier: AGPL-3.0-only
// Variables d'observabilité (14 § 2) : lues une fois, validées, sans valeur implicite vers l'extérieur (INV9).
import { secretValues, Secret } from '../crypto/redact.js';

export class ObservabilityConfigError extends Error {
  override name = 'ObservabilityConfigError';
}

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const ARTIFACT_LEVELS = ['none', 'screenshot_on_failure', 'trace_on_failure', 'har_minimal'] as const;
export type ArtifactLevel = (typeof ARTIFACT_LEVELS)[number];

export const OTEL_PROTOCOLS = ['http/protobuf', 'http/json'] as const;
export type OtelProtocol = (typeof OTEL_PROTOCOLS)[number];

export const OTEL_SAMPLERS = [
  'always_on',
  'always_off',
  'traceidratio',
  'parentbased_always_on',
  'parentbased_always_off',
  'parentbased_traceidratio',
] as const;
export type OtelSampler = (typeof OTEL_SAMPLERS)[number];

export type OtelConfig =
  | { enabled: false }
  | {
      enabled: true;
      /** URL complète du point de dépôt des traces (`…/v1/traces`). */
      tracesUrl: string;
      protocol: OtelProtocol;
      /** En-têtes d'export : traités comme un secret (INV8). */
      headers: Secret | null;
      sampler: OtelSampler;
      samplerArg: number;
      serviceName: string;
    };

export type ObservabilityConfig = {
  logLevel: LogLevel;
  otel: OtelConfig;
  artifacts: { level: ArtifactLevel; maxBytes: number; quotaBytes: number; retentionDays: number };
  runLogRetentionDays: number;
};

function oneOf<T extends string>(env: NodeJS.ProcessEnv, name: string, allowed: readonly T[], fallback: T): T {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) throw new ObservabilityConfigError(`${name} invalide : ${allowed.join(', ')}.`);
  return raw as T;
}

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new ObservabilityConfigError(`${name} invalide : nombre > 0 attendu.`);
  return value;
}

/** `OTEL_EXPORTER_OTLP_HEADERS` : `clé=valeur,clé2=valeur2`. Chaque valeur rejoint le registre de masquage. */
function parseHeaders(raw: string | undefined): Secret | null {
  if (!raw?.trim()) return null;
  for (const pair of raw.split(',')) {
    const value = pair.slice(pair.indexOf('=') + 1).trim();
    if (pair.includes('=') && value.length > 0) secretValues.add(value);
  }
  secretValues.add(raw.trim());
  return new Secret(raw.trim());
}

export function parseOtelConfig(env: NodeJS.ProcessEnv): OtelConfig {
  // Opt-in strict : seule la valeur `true` active. Rien d'autre (ni OTEL_SDK_DISABLED, ni un endpoint seul) ne suffit.
  if (env['OTEL_ENABLED']?.trim().toLowerCase() !== 'true') return { enabled: false };
  const endpoint = env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim();
  if (!endpoint) throw new ObservabilityConfigError('OTEL_ENABLED=true exige OTEL_EXPORTER_OTLP_ENDPOINT (aucune destination implicite).');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ObservabilityConfigError('OTEL_EXPORTER_OTLP_ENDPOINT invalide : URL http(s) attendue.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ObservabilityConfigError('OTEL_EXPORTER_OTLP_ENDPOINT invalide : URL http(s) attendue.');
  if (url.username || url.password) throw new ObservabilityConfigError('OTEL_EXPORTER_OTLP_ENDPOINT : identifiants dans l’URL refusés, utilisez OTEL_EXPORTER_OTLP_HEADERS.');
  const base = url.toString().replace(/\/+$/, '');
  const samplerArg = Number(env['OTEL_TRACES_SAMPLER_ARG'] ?? 0.1);
  if (!Number.isFinite(samplerArg) || samplerArg < 0 || samplerArg > 1) throw new ObservabilityConfigError('OTEL_TRACES_SAMPLER_ARG invalide : nombre entre 0 et 1.');
  return {
    enabled: true,
    tracesUrl: `${base}/v1/traces`,
    protocol: oneOf(env, 'OTEL_EXPORTER_OTLP_PROTOCOL', OTEL_PROTOCOLS, 'http/protobuf'),
    headers: parseHeaders(env['OTEL_EXPORTER_OTLP_HEADERS']),
    sampler: oneOf(env, 'OTEL_TRACES_SAMPLER', OTEL_SAMPLERS, 'parentbased_traceidratio'),
    samplerArg,
    serviceName: env['OTEL_SERVICE_NAME']?.trim() || 'scrapyomama',
  };
}

/** Retire de l'environnement les variables OTel : le SDK et les exporteurs ne relisent rien d'autre que la configuration validée. */
export function scrubOtelEnvironment(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) if (name.startsWith('OTEL_') && name !== 'OTEL_ENABLED') delete env[name];
}

export function loadObservabilityConfig(env: NodeJS.ProcessEnv = process.env): ObservabilityConfig {
  return {
    logLevel: oneOf(env, 'LOG_LEVEL', LOG_LEVELS, 'info'),
    otel: parseOtelConfig(env),
    artifacts: {
      level: oneOf(env, 'ARTIFACTS_LEVEL', ARTIFACT_LEVELS, 'none'),
      maxBytes: Math.floor(positive(env, 'ARTIFACT_MAX_BYTES', 5 * 1024 * 1024)),
      quotaBytes: Math.floor(positive(env, 'ARTIFACT_QUOTA_MB', 500) * 1024 * 1024),
      retentionDays: positive(env, 'ARTIFACT_RETENTION_DAYS', 7),
    },
    runLogRetentionDays: positive(env, 'RUN_LOG_RETENTION_DAYS', 30),
  };
}
