// SPDX-License-Identifier: AGPL-3.0-only
// Mention fournisseur (08 § 4 point 5, 19 § 3, tâche 2.12) : fournisseurs qui recevront des extraits d'une API. Rôles
// d'enquête, de réparation, d'extraction et d'agent, et `reflect` s'il est affecté ; `judge` s'il est activé ; `embed` si
// l'étage 4 de la mémoire l'est. Même règle que `providersReceiving` de la couche LLM (le Front n'importe pas le Brain).
type RoleChoice = { readonly provider?: string; readonly model?: string } | null | undefined;
export type ProviderNoticeSettings = {
  readonly roles?: Readonly<Record<string, RoleChoice>> | null;
  readonly judge?: { readonly enabled?: boolean } | null;
  readonly catalog_memory?: { readonly embeddings?: boolean } | null;
};

export function providersReceiving(settings: ProviderNoticeSettings | null | undefined): string[] {
  const roles = settings?.roles ?? {};
  const judge = settings?.judge?.enabled === true && (roles['judge'] ?? null) !== null;
  const embed = settings?.catalog_memory?.embeddings === true && (roles['embed'] ?? null) !== null;
  const order = ['investigate', 'repair', 'extract', 'agent', ...(judge ? ['judge'] : []), 'reflect', ...(embed ? ['embed'] : [])];
  const out: string[] = [];
  for (const role of order) {
    const provider = roles[role]?.provider;
    if (typeof provider === 'string' && provider !== '' && !out.includes(provider)) out.push(provider);
  }
  return out;
}
