// Observabilité (tâche 1.10, INV8, INV9) : configuration sans destination implicite, OTel coupé par défaut (aucun module
// `@opentelemetry/*` résolu), journal masqué avec `run_id`, politique des artefacts, spans masqués et sans contenu LLM.
import { spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { InMemorySpanExporter, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, test } from 'vitest';
import { SecretValueRegistry } from '../crypto/redact.js';
import { artifactDenial } from './artifacts.js';
import { loadObservabilityConfig, ObservabilityConfigError, parseOtelConfig, scrubOtelEnvironment } from './config.js';
import { createLogger } from './logger.js';
import { currentTraceparent, initTelemetry, withSpan, type Telemetry } from './otel.js';
import { currentRunId, withRunContext } from './run-context.js';

const CORE_DIST = new URL('../../dist/index.js', import.meta.url).href;

describe('configuration', () => {
  test('défauts : OTel coupé, artefacts au niveau 0, journal info, métriques sans jeton', () => {
    const c = loadObservabilityConfig({});
    expect(c.otel).toEqual({ enabled: false });
    expect(c.artifacts.level).toBe('none');
    expect(c.logLevel).toBe('info');
    expect(c.artifacts.maxBytes).toBe(5 * 1024 * 1024);
    expect(c.artifacts.quotaBytes).toBe(500 * 1024 * 1024);
    expect(c.runLogRetentionDays).toBe(30);
  });

  test('un endpoint seul n’active rien ; OTEL_ENABLED exige un endpoint explicite (aucune destination implicite)', () => {
    expect(parseOtelConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.zz-test:4318' })).toEqual({ enabled: false });
    expect(parseOtelConfig({ OTEL_ENABLED: 'false', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector.zz-test:4318' })).toEqual({ enabled: false });
    expect(() => parseOtelConfig({ OTEL_ENABLED: 'true' })).toThrow(ObservabilityConfigError);
    expect(() => parseOtelConfig({ OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'ftp://x' })).toThrow(/http\(s\)/);
    expect(() => parseOtelConfig({ OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://u:p@x:4318' })).toThrow(/identifiants/);
    expect(() => parseOtelConfig({ OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://x', OTEL_TRACES_SAMPLER_ARG: '2' })).toThrow(/SAMPLER_ARG/);
  });

  test('activé : valeurs par défaut de 14 § 2, en-têtes traités comme un secret', () => {
    const c = parseOtelConfig({ OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.zz-test:4318/', OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer zz_canary_otlp' });
    expect(c).toMatchObject({ enabled: true, tracesUrl: 'https://collector.zz-test:4318/v1/traces', protocol: 'http/protobuf', sampler: 'parentbased_traceidratio', samplerArg: 0.1, serviceName: 'scrapyomama' });
    if (!c.enabled) throw new Error('attendu : activé');
    expect(JSON.stringify(c)).not.toContain('zz_canary_otlp');
    expect(String(c.headers)).toBe('[REDACTED]');
  });

  test('scrubOtelEnvironment retire les variables OTEL_ (sauf OTEL_ENABLED) de l’environnement', () => {
    const env: NodeJS.ProcessEnv = { OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_HEADERS: 'a=b', OTEL_SERVICE_NAME: 'x', PATH: '/bin' };
    scrubOtelEnvironment(env);
    expect(Object.keys(env).sort()).toEqual(['OTEL_ENABLED', 'PATH']);
  });

  test('niveaux et bornes invalides refusés', () => {
    expect(() => loadObservabilityConfig({ LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
    expect(() => loadObservabilityConfig({ ARTIFACTS_LEVEL: 'everything' })).toThrow(/ARTIFACTS_LEVEL/);
    expect(() => loadObservabilityConfig({ ARTIFACT_MAX_BYTES: '-1' })).toThrow(/ARTIFACT_MAX_BYTES/);
  });
});

describe('assert_otel_off_by_default : modules chargés', () => {
  /** Processus frais : les résolutions de `@opentelemetry/*` sont relevées par un crochet de module. */
  function resolvedOtelModules(env: Record<string, string>): { enabled: boolean; seen: string[] } {
    const script = `
      import { registerHooks } from 'node:module';
      const seen = [];
      registerHooks({ resolve(specifier, context, next) { if (specifier.includes('opentelemetry')) seen.push(specifier); return next(specifier, context); } });
      const core = await import(${JSON.stringify(CORE_DIST)});
      const telemetry = await core.initTelemetry(core.parseOtelConfig(process.env));
      await core.withSpan('zz_test', {}, () => 1);
      await telemetry.shutdown();
      console.log(JSON.stringify({ enabled: telemetry.enabled, seen }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env['PATH'] ?? '', ...env }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`processus enfant : ${result.stderr}`);
    return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { enabled: boolean; seen: string[] };
  }

  test('assert_otel_off_by_default : sans OTEL_ENABLED, aucun module @opentelemetry/* n’est résolu (même avec un endpoint)', () => {
    expect(resolvedOtelModules({})).toEqual({ enabled: false, seen: [] });
    expect(resolvedOtelModules({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' })).toEqual({ enabled: false, seen: [] });
    expect(resolvedOtelModules({ OTEL_ENABLED: 'false', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1' })).toEqual({ enabled: false, seen: [] });
  });

  test('témoin : avec OTEL_ENABLED=true le crochet voit bien les modules du SDK', () => {
    const on = resolvedOtelModules({ OTEL_ENABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:1', OTEL_TRACES_SAMPLER: 'always_off' });
    expect(on.enabled).toBe(true);
    expect(on.seen).toEqual(expect.arrayContaining(['@opentelemetry/api', '@opentelemetry/sdk-trace-base']));
  });
});

describe('journal pino', () => {
  function capture() {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    return { lines, destination };
  }

  test('masque les valeurs connues, chemins explicites et URL ; ajoute run_id depuis le contexte', () => {
    const registry = new SecretValueRegistry();
    registry.add('zz_canary_llm_key_0123456789');
    const { lines, destination } = capture();
    const log = createLogger({ name: 'zz_test', destination, registry });
    withRunContext('run-42', () => {
      log.info({ apiKey: 'autre-valeur', headers: { authorization: 'Bearer abc' }, url: 'https://user:pass@example.test/p?token=zz' }, 'appel zz_canary_llm_key_0123456789');
      expect(currentRunId()).toBe('run-42');
    });
    log.info('hors contexte');
    const [first, second] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(first).toMatchObject({ run_id: 'run-42', apiKey: '[REDACTED]' });
    expect(lines[0]).not.toContain('zz_canary_llm_key_0123456789');
    expect(lines[0]).not.toContain('user:pass');
    expect(lines[0]).not.toContain('Bearer abc');
    expect(second).not.toHaveProperty('run_id');
    expect(currentRunId()).toBeUndefined();
  });

  test('erreur : message et pile nettoyés', () => {
    const registry = new SecretValueRegistry();
    registry.add('zz_canary_error_secret_xyz');
    const { lines, destination } = capture();
    const log = createLogger({ name: 'zz_test', destination, registry });
    log.error({ err: new Error('échec avec zz_canary_error_secret_xyz') }, 'boom');
    expect(lines[0]).not.toContain('zz_canary_error_secret_xyz');
  });

  test('niveau : debug écarté au niveau info', () => {
    const { lines, destination } = capture();
    const log = createLogger({ name: 'zz_test', level: 'warn', destination });
    log.info('non');
    log.warn('oui');
    expect(lines).toHaveLength(1);
  });
});

describe('politique des artefacts', () => {
  const failed = { failed: true };
  test('niveau 0 : jamais, quel que soit le run', () => {
    for (const kind of ['screenshot', 'trace', 'har'] as const) expect(artifactDenial('none', kind, failed)).toBe('level_none');
  });
  test('niveaux supérieurs : seulement leurs types, seulement sur échec', () => {
    expect(artifactDenial('screenshot_on_failure', 'screenshot', failed)).toBeNull();
    expect(artifactDenial('screenshot_on_failure', 'trace', failed)).toBe('level_excludes_kind');
    expect(artifactDenial('trace_on_failure', 'trace', failed)).toBeNull();
    expect(artifactDenial('trace_on_failure', 'har', failed)).toBe('level_excludes_kind');
    expect(artifactDenial('har_minimal', 'har', failed)).toBeNull();
    expect(artifactDenial('har_minimal', 'har', { failed: false })).toBe('run_not_failed');
  });
  test('jamais sur un run à session serveur, en tunnel ou ayant rencontré un défi', () => {
    expect(artifactDenial('har_minimal', 'har', { failed: true, serverSession: true })).toBe('server_session');
    expect(artifactDenial('har_minimal', 'har', { failed: true, tunnel: true })).toBe('tunnel');
    expect(artifactDenial('har_minimal', 'har', { failed: true, challenge: true })).toBe('challenge');
  });
});

describe('traces (OTel activé, exporteur en mémoire)', () => {
  let telemetry: Telemetry | undefined;
  afterEach(async () => {
    await telemetry?.shutdown();
    telemetry = undefined;
  });
  const config = {
    enabled: true as const,
    tracesUrl: 'http://127.0.0.1:1/v1/traces',
    protocol: 'http/json' as const,
    headers: null,
    sampler: 'always_on' as const,
    samplerArg: 1,
    serviceName: 'zz_test',
  };

  test('OTel coupé : withSpan exécute la fonction, aucun traceparent', async () => {
    expect(currentTraceparent()).toBeUndefined();
    expect(await withSpan('zz', {}, () => 7)).toBe(7);
    expect(await initTelemetry({ enabled: false })).toMatchObject({ enabled: false });
  });

  test('spans masqués (INV8), contenu LLM retiré, parent repris du traceparent du job (_trace)', async () => {
    const registry = new SecretValueRegistry();
    registry.add('zz_canary_span_secret_42');
    const exporter = new InMemorySpanExporter();
    telemetry = await initTelemetry(config, { exporter, registry });
    let parent = '';
    await withSpan('web.enqueue', {}, async () => {
      parent = currentTraceparent() ?? '';
    });
    expect(parent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
    await withSpan(
      'run.execute zz_canary_span_secret_42',
      { attributes: { run_id: 'r1', 'gen_ai.prompt': 'contenu du prompt', 'llm.completion': 'réponse', note: 'avec zz_canary_span_secret_42' }, parentTraceparent: parent },
      (span) => {
        span.setAttribute('detail', 'zz_canary_span_secret_42');
        span.fail('code_error');
      },
    );
    await telemetry.forceFlush();
    const spans: ReadableSpan[] = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    const child = spans.find((s) => s.name.startsWith('run.execute'))!;
    const root = spans.find((s) => s.name === 'web.enqueue')!;
    expect(child.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(child.parentSpanContext?.spanId).toBe(root.spanContext().spanId);
    // L'exporteur en mémoire reçoit les spans APRÈS le filtre : c'est ce qui partirait vers le collecteur.
    expect(JSON.stringify({ n: child.name, a: child.attributes, s: child.status })).not.toContain('zz_canary_span_secret_42');
    expect(child.attributes).toMatchObject({ run_id: 'r1', 'error.class': 'code_error' });
    expect(child.attributes).not.toHaveProperty('gen_ai.prompt');
    expect(child.attributes).not.toHaveProperty('llm.completion');
  });

  test('traceparent invalide ou nul : le span devient une racine', async () => {
    const exporter = new InMemorySpanExporter();
    telemetry = await initTelemetry(config, { exporter });
    await withSpan('a', { parentTraceparent: `00-${'0'.repeat(32)}-${'0'.repeat(16)}-01` }, () => undefined);
    await withSpan('b', { parentTraceparent: 'pas-un-traceparent' }, () => undefined);
    await telemetry.forceFlush();
    for (const s of exporter.getFinishedSpans()) expect(s.parentSpanContext).toBeUndefined();
  });
});
