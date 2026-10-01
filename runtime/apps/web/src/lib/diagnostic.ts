// SPDX-License-Identifier: AGPL-3.0-only
// Diagnostic local (06 § 2, INV9) : un fichier JSON construit dans le navigateur à partir de routes publiques de
// l'instance, téléchargé sur l'ordinateur de l'utilisateur. Aucun envoi nulle part. Liste blanche de champs : jamais de
// clé, de cookie, de contenu de run ni de donnée personnelle.
import type { ApiClient } from '@runtime/client';

export interface Diagnostic {
  generated_at: string;
  console_locale: string;
  /** Les quatre champs de `GET /api/version` (16 §3) : version de l'instance, du schéma, minimum de l'extension, spécification MCP. */
  instance: { server: string | null; schema: number | null; min_extension: string | null; mcp_spec: string | null };
  readiness: { ok: boolean | null };
}

/** Rassemble le diagnostic ; une route qui échoue laisse son champ à null (le diagnostic reste exportable). */
export async function collectDiagnostic(api: ApiClient, locale: string, now: Date = new Date()): Promise<Diagnostic> {
  const [version, ready] = await Promise.allSettled([api.GET('/api/version'), api.GET('/api/ready')]);
  const versionData = version.status === 'fulfilled' ? version.value.data : undefined;
  return {
    generated_at: now.toISOString(),
    console_locale: locale,
    instance: {
      server: text(versionData?.server),
      schema: typeof versionData?.schema === 'number' ? versionData.schema : null,
      min_extension: text(versionData?.min_extension),
      mcp_spec: text(versionData?.mcp_spec),
    },
    readiness: { ok: ready.status === 'fulfilled' ? ready.value.response.ok : null },
  };
}

/** Liste blanche typée : seule une chaîne passe ; toute autre forme (route plus ancienne, champ absent) donne null. */
function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Télécharge le diagnostic comme fichier local (Blob et lien, aucun envoi). */
export function downloadDiagnostic(diagnostic: Diagnostic): void {
  const blob = new Blob([JSON.stringify(diagnostic, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'scrapyomama-diagnostic.json';
  link.click();
  URL.revokeObjectURL(url);
}
