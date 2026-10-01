// SPDX-License-Identifier: AGPL-3.0-only
// Environnement Vitest « client » sans navigateur : les composants .vue sont compilés avec leur fonction de rendu client
// (et non `ssrRender`), pour un montage par `mountHtml` (memory-mount.ts). Aucun DOM n'est simulé : ni `window` ni
// `document`, les composables gardent leur comportement hors navigateur. Un fichier de test le choisit par la ligne
// `@vitest-environment vue-client` ; vitest.config.ts relie `vitest-environment-vue-client` à ce fichier.
import type { Environment } from 'vitest/runtime';

const environment: Environment = {
  name: 'vue-client',
  viteEnvironment: 'client',
  setup() {
    return { teardown() {} };
  },
};

export default environment;
