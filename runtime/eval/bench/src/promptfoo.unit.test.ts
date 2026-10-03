// SPDX-License-Identifier: AGPL-3.0-only
// promptfoo en image Docker, sans téléversement (15 §11) : image épinglée par empreinte, télémétrie, partage, mise à jour et
// génération distante coupés par les variables de la version épinglée (vérifiées dans dist/ de l'image 0.122.2, point « à
// valider » de 15 §13), `--no-share`, réseau Docker interne (aucune route hors de l'hôte : seul le point d'accès du banc,
// sur la passerelle, est joignable). `assert_no_telemetry` couvre le job.
import { parse } from 'yaml';
import { describe, expect, test } from 'vitest';
import { BENCH_TASKS } from './catalog.ts';
import { PROMPTFOO_ENV, PROMPTFOO_IMAGE, parsePromptfooOutput, promptfooConfig, promptfooDockerArgs } from './promptfoo.ts';

const ARGS = promptfooDockerArgs({ network: 'zz_test_eval_net', configDir: '/tmp/zz_test_cfg', outDir: '/tmp/zz_test_out', repeat: 3 });

describe('job promptfoo', () => {
  test('assert_no_telemetry — job du banc : télémétrie, partage, mise à jour et génération distante coupés, réseau interne, aucun partage', () => {
    expect(PROMPTFOO_ENV).toMatchObject({
      PROMPTFOO_DISABLE_TELEMETRY: '1',
      PROMPTFOO_DISABLE_SHARING: '1',
      PROMPTFOO_DISABLE_UPDATE: '1',
      PROMPTFOO_DISABLE_REMOTE_GENERATION: 'true',
      PROMPTFOO_DISABLE_REDTEAM_REMOTE_GENERATION: 'true',
    });
    for (const [name, value] of Object.entries(PROMPTFOO_ENV)) expect(ARGS.join(' ')).toContain(`-e ${name}=${value}`);
    expect(ARGS.slice(ARGS.indexOf('--network'), ARGS.indexOf('--network') + 2)).toEqual(['--network', 'zz_test_eval_net']);
    expect(ARGS).not.toContain('host');
    expect(ARGS).toContain('--no-share');
    expect(ARGS).not.toContain('--share');
    expect(ARGS).toContain('--no-write');
    // Configuration montée en lecture seule ; seul le dossier de sortie est inscriptible.
    expect(ARGS).toContain('/tmp/zz_test_cfg:/bench:ro');
    expect(ARGS).toContain('/tmp/zz_test_out:/out');
    const config = promptfooConfig({ tasks: BENCH_TASKS, endpoint: 'http://172.18.0.1:4000', level: 'N1', models: ['zz-model-a'] });
    expect(config.sharing).toBe(false);
    expect(JSON.stringify(config)).not.toMatch(/promptfoo\.(app|dev)|posthog/);
  });

  test('image épinglée par empreinte, version sortie depuis plus de 7 jours (0.122.2, 2026-08-28)', () => {
    expect(PROMPTFOO_IMAGE).toMatch(/^ghcr\.io\/promptfoo\/promptfoo:0\.122\.2@sha256:[0-9a-f]{64}$/);
    expect(ARGS).toContain(PROMPTFOO_IMAGE);
    expect(ARGS.slice(ARGS.indexOf(PROMPTFOO_IMAGE))).toEqual(expect.arrayContaining(['eval', '-c', '/bench/promptfooconfig.yaml', '--repeat', '3', '-o', '/out/promptfoo.json']));
  });

  test('configuration : un test par tâche et par modèle, fournisseur http vers le point d’accès du banc, assertion sur la référence', () => {
    const config = promptfooConfig({ tasks: BENCH_TASKS.slice(0, 2), endpoint: 'http://172.18.0.1:4000', level: 'N1', models: ['zz-model-a', 'zz-model-b'] });
    const yaml = parse(config.yaml) as Record<string, unknown>;
    expect(yaml['sharing']).toBe(false);
    const providers = yaml['providers'] as { id: string; label: string; config: { url: string; method: string; body: Record<string, string> } }[];
    expect(providers.map((p) => p.label)).toEqual(['zz-model-a', 'zz-model-b']);
    for (const provider of providers) {
      expect(provider.id).toBe('http');
      expect(provider.config.url).toBe('http://172.18.0.1:4000/case');
      expect(provider.config.method).toBe('POST');
      expect(provider.config.body).toMatchObject({ task_id: '{{task_id}}', model_id: provider.label, level: 'N1' });
    }
    const tests = yaml['tests'] as { vars: { task_id: string }; assert: { type: string; value: string }[] }[];
    expect(tests.map((t) => t.vars.task_id)).toEqual(BENCH_TASKS.slice(0, 2).map((t) => t.id));
    expect(tests[0]!.assert[0]).toMatchObject({ type: 'javascript' });
  });

  test('sortie promptfoo → enregistrements du banc (numéro de répétition par tâche et modèle)', () => {
    const record = (task: string, model: string, success: boolean) => ({
      vars: { task_id: task },
      provider: { label: model },
      response: { output: { level: 'N1', model_id: model, task_id: task, kind: 'investigation', repetition: 0, success, false_success: false, level_retained: 'E1', level_e_min: 'E1', cost_usd: 0.01, inv_violations: [] } },
    });
    const out = { results: { results: [record('T-api_json', 'zz-model-a', true), record('T-api_json', 'zz-model-a', false), record('T-ssr', 'zz-model-a', true)] } };
    const records = parsePromptfooOutput(out);
    expect(records.map((r) => [r.task_id, r.repetition, r.success])).toEqual([
      ['T-api_json', 0, true],
      ['T-api_json', 1, false],
      ['T-ssr', 0, true],
    ]);
    // Une réponse hors schéma (erreur du point d'accès, réponse tronquée) est rejetée, jamais comptée comme un succès.
    expect(() => parsePromptfooOutput({ results: { results: [{ vars: { task_id: 'T-ssr' }, provider: { label: 'm' }, response: { output: { success: true } } }] } })).toThrow();
  });
});
