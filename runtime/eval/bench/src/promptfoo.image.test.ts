// SPDX-License-Identifier: AGPL-3.0-only
// Job promptfoo réel, dans son image épinglée (15 §11) : réseau Docker interne créé pour le job, point d'accès du banc sur
// la passerelle, un appel par (tâche, modèle, répétition), sortie relue en enregistrements. Le harnais est remplacé par un
// bouchon (aucune base, aucun LLM) : on éprouve ici l'outillage et l'isolement réseau, pas l'agent.
// `assert_no_telemetry` (job du banc) : le conteneur n'a aucune route hors de l'hôte ; une requête vers l'extérieur depuis le
// même type de réseau échoue.
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';
import { PROMPTFOO_ENV, PROMPTFOO_IMAGE } from './promptfoo.ts';
import { runPromptfooJob } from './promptfoo-run.ts';
import type { BenchRecord } from './records.ts';

const record = (taskId: string, modelId: string, success: boolean): BenchRecord => ({
  level: 'N1',
  model_id: modelId,
  task_id: taskId,
  kind: 'investigation',
  repetition: 0,
  success,
  false_success: false,
  level_retained: success ? 'E1' : null,
  level_e_min: 'E1',
  cost_usd: 0.001,
  inv_violations: [],
});

describe('job promptfoo (image épinglée, réseau interne)', () => {
  test('assert_no_telemetry — 2 tâches × 2 modèles × 2 répétitions, chaque appel passe par le point d’accès du banc, aucune route vers l’extérieur', async () => {
    const calls: string[] = [];
    let n = 0;
    const job = await runPromptfooJob({
      level: 'N1',
      models: ['zz-model-a', 'zz-model-b'],
      cases: ['T-api_json', 'T-ssr'],
      repeat: 2,
      runCase: async (caseId, modelId) => {
        calls.push(`${modelId}/${caseId}`);
        return record(caseId, modelId, ++n % 3 !== 0);
      },
    });
    expect(job.network.internal).toBe(true);
    expect(calls.sort()).toEqual(['zz-model-a/T-api_json', 'zz-model-a/T-api_json', 'zz-model-a/T-ssr', 'zz-model-a/T-ssr', 'zz-model-b/T-api_json', 'zz-model-b/T-api_json', 'zz-model-b/T-ssr', 'zz-model-b/T-ssr']);
    expect(job.records).toHaveLength(8);
    for (const model of ['zz-model-a', 'zz-model-b']) {
      for (const task of ['T-api_json', 'T-ssr']) {
        expect(job.records.filter((r) => r.model_id === model && r.task_id === task).map((r) => r.repetition).sort()).toEqual([0, 1]);
      }
    }
    // Réseau retiré à la fin du job.
    expect(spawnSync('docker', ['network', 'inspect', job.network.name]).status).not.toBe(0);
  });

  test('depuis un réseau interne, l’image n’atteint pas l’extérieur (télémétrie, partage, mise à jour impossibles même si une variable manquait)', () => {
    const name = `zz_sym_eval_probe_${process.pid}`;
    expect(spawnSync('docker', ['network', 'create', '--internal', name]).status).toBe(0);
    try {
      const env = Object.entries(PROMPTFOO_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const probe = spawnSync(
        'docker',
        ['run', '--rm', '--network', name, ...env, '--entrypoint', 'node', PROMPTFOO_IMAGE, '-e', "fetch('https://api.promptfoo.app/health').then(()=>console.log('REACHED'),e=>console.log('BLOCKED',e.cause?.code??e.message))"],
        { encoding: 'utf8', timeout: 120_000 },
      );
      expect(probe.stdout).toContain('BLOCKED');
      expect(probe.stdout).not.toContain('REACHED');
    } finally {
      spawnSync('docker', ['network', 'rm', name]);
    }
  });
});
