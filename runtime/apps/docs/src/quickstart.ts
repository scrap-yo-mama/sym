// SPDX-License-Identifier: AGPL-3.0-only
// Le tutoriel « Démarrage rapide » est une source exécutable : chaque bloc `bash` précédé d'un marqueur
// `<!-- quickstart {...} -->` est une étape que la CI rejoue (tests/quickstart.integration.test.ts). Ce module extrait ces
// étapes ; la doc et le rejeu ne peuvent donc pas diverger.

type StepMode =
  /** Commandes exécutées telles quelles dans un shell (curl, openssl…). */
  | 'run'
  /** Étape qui lance l'instance (`docker compose up`) : le rejeu fait le même travail avec les processus de l'image, sans Docker. */
  | 'process'
  /** Étape décrite mais pas encore rejouable : sa dépendance n'est pas livrée (`pending` dit laquelle). */
  | 'pending';

export type QuickstartStep = {
  id: string;
  mode: StepMode;
  /** Textes qui doivent figurer dans la sortie de l'étape (mode `run`). */
  expect: string[];
  /** Mode `pending` : ce qui manque. */
  pending?: string;
  /** Mode `process` : ce que fait le rejeu à la place de la commande. */
  replay?: string;
  /**
   * Terminal où l'étape se tape : 1 jusqu'à l'étape qui lance l'instance (`process`, qui garde son terminal occupé),
   * 2 ensuite. Un second terminal ne reçoit aucune variable du premier : le rejeu le simule.
   */
  terminal: number;
  script: string;
};

const BLOCK = /<!-- quickstart (\{[^\n]*\}) -->\n```bash\n([\s\S]*?)\n```/g;

export function parseQuickstart(markdown: string): QuickstartStep[] {
  const steps: QuickstartStep[] = [];
  let terminal = 1;
  for (const match of markdown.matchAll(BLOCK)) {
    const meta = JSON.parse(match[1] ?? '{}') as { id?: string; mode?: string; expect?: string | string[]; pending?: string; replay?: string };
    if (!meta.id || !/^[a-z0-9-]+$/.test(meta.id)) throw new Error(`quickstart : identifiant d'étape invalide (${String(meta.id)})`);
    if (meta.mode !== 'run' && meta.mode !== 'process' && meta.mode !== 'pending') throw new Error(`quickstart : mode inconnu pour l'étape ${meta.id} (${String(meta.mode)})`);
    steps.push({
      id: meta.id,
      mode: meta.mode,
      expect: meta.expect === undefined ? [] : Array.isArray(meta.expect) ? meta.expect : [meta.expect],
      ...(meta.pending !== undefined ? { pending: meta.pending } : {}),
      ...(meta.replay !== undefined ? { replay: meta.replay } : {}),
      terminal,
      script: match[2] ?? '',
    });
    if (meta.mode === 'process') terminal += 1;
  }
  return steps;
}

/** Adresse du tutoriel : le rejeu la remplace par celle de l'instance de test. */
export const QUICKSTART_BASE_URL = 'http://localhost:3100';
