// SPDX-License-Identifier: AGPL-3.0-only
// Diagnostic local (06 § 2, INV9) : un fichier JSON construit dans le navigateur à partir de routes publiques de
// l'instance, téléchargé sur l'ordinateur de l'utilisateur. Aucun envoi nulle part. Liste blanche de champs : jamais de
// clé, de cookie, de contenu de run ni de donnée personnelle.
import type { ApiClient } from '@runtime/client';

export interface Diagnostic {
  generated_at: string;
  console_locale: string;
  instance: { version: string | null; schema_version: number | null };
  readiness: { ok: boolean | null };
}

/** Rassemble le diagnostic ; une route qui échoue laisse son champ à null (le diagnostic reste exportable). */
export async function collectDiagnostic(api: ApiClient, locale: string, now: Date = new Date()): Promise<Diagnostic> {
  const [version, ready] = await Promise.allSettled([api.GET('/api/version'), api.GET('/api/ready')]);
  const versionData = version.status === 'fulfilled' ? version.value.data : undefined;
  return {
    generated_at: now.toISOString(),
    console_locale: locale,
    instance: { version: versionData?.version ?? null, schema_version: versionData?.schema_version ?? null },
    readiness: { ok: ready.status === 'fulfilled' ? ready.value.response.ok : null },
  };
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
