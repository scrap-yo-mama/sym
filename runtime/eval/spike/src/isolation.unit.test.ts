// SPDX-License-Identifier: AGPL-3.0-only
// Isolement du paquet d'évaluation (protocole §13 ; revue 0.6a, point 4) : l'étape de build Docker (`COPY . .` puis
// `pnpm install --frozen-lockfile`) ne doit jamais voir eval/, sinon Stagehand et le SDK Browserbase y sont installés.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runtimeDir = new URL('../../../', import.meta.url).pathname;

describe('isolement de eval/spike dans la chaîne de build', () => {
  it('.dockerignore exclut eval/ du contexte de build', () => {
    const lines = readFileSync(`${runtimeDir}.dockerignore`, 'utf8').split('\n').map((l) => l.trim());
    expect(lines).toContain('eval');
  });
});

describe('annexe brute du spike (eval/results)', () => {
  const files = ['spike-0.6a-runs.jsonl', 'spike-0.6a-runs.traces.jsonl', 'spike-0.6a-runs.meta.json'].map((f) => readFileSync(`${runtimeDir}eval/results/${f}`, 'utf8'));
  it('aucune clé ni en-tête d\'authentification', () => {
    for (const text of files) expect(text).not.toMatch(/sk-[A-Za-z0-9]{8,}|bearer\s+[A-Za-z0-9._-]{8,}|"(api_?key|authorization|token)"\s*:/i);
  });
  it('aucune URL hors fixtures (*.localhost), hormis la source du prix du fournisseur', () => {
    const urls = files.flatMap((text) => [...text.matchAll(/(?:https?|wss?):\/\/[^\s"'),]+/g)].map((m) => m[0]));
    const outside = urls.filter((u) => !/^(?:https?|wss?):\/\/[a-z0-9_.-]+\.localhost(?:[:/]|$)/i.test(u) && !u.startsWith('https://deepinfra.com/zai-org/GLM-5.3'));
    expect(outside).toEqual([]);
  });
});
