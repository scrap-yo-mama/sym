// SPDX-License-Identifier: AGPL-3.0-only
// assert_no_csp_violation (tâche 3.15, 20b § 3.1) : la CSP stricte de la console (08b § 2) et le relevé de ses violations, partagés
// par les deux bancs E2E de la console (faux serveur d'API de apps/web/e2e, instance réelle de tests/e2e). Chaque banc pose
// CONSOLE_CSP sur chaque page servie ; chaque contexte de navigateur relève ses événements `securitypolicyviolation` et chaque test
// échoue s'il en a laissé un. Écrit sans les types DOM : le typage de tests/e2e n'a que Node.
import type { BrowserContext } from '@playwright/test';

/** CSP stricte de la console (08b § 2) : aucune source tierce, ni script ni style en ligne. */
export const CONSOLE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

type ViolationEvent = { violatedDirective: string; blockedURI: string; sample: string };
type PageScope = {
  document: { addEventListener: (type: 'securitypolicyviolation', listener: (event: ViolationEvent) => void) => void };
  __zzCspViolation?: (report: string) => Promise<void>;
};

/**
 * Relève les violations de CSP de chaque page du contexte (navigations comprises), « URL — directive : ressource », dans `sink`
 * (partageable entre plusieurs contextes) ; à vérifier vide à la fin de chaque test.
 */
export async function watchCspViolations(context: BrowserContext, sink: string[] = []): Promise<string[]> {
  await context.exposeBinding('__zzCspViolation', ({ frame }, report: string) => void sink.push(`${frame.url()} — ${report}`));
  await context.addInitScript(() => {
    const scope = globalThis as unknown as PageScope;
    scope.document.addEventListener('securitypolicyviolation', (event) => {
      void scope.__zzCspViolation?.(`${event.violatedDirective} : ${event.blockedURI || event.sample || 'inline'}`);
    });
  });
  return sink;
}
