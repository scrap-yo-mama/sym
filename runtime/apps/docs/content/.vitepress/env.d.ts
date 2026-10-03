// SPDX-License-Identifier: AGPL-3.0-only
// Types d'ambiance du thème : composants .vue de @runtime/ui (compilés par VitePress) et feuilles de style importées.
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
declare module '*.css';
