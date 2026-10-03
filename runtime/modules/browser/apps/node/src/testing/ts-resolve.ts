// SPDX-License-Identifier: AGPL-3.0-only
// Tests seulement : permet de lancer un point d'entrée TypeScript du nœud dans un processus Node 24 séparé (suppression des
// types native, `erasableSyntaxOnly`) sans compilation préalable. Les sources importent `./x.js` (NodeNext) : quand ce
// fichier n'existe pas, le module `./x.ts` voisin est chargé à sa place. Aucun autre effet (paquets et `.js` réels inchangés).
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      throw error;
    }
  },
});
