// SPDX-License-Identifier: AGPL-3.0-only
// URL de l'instance saisie à l'appairage (07 § 1) : HTTPS obligatoire ; HTTP n'est accepté que pour une instance
// locale de développement (boucle locale). Cette exception ne concerne que l'instance, jamais un site connecté (INV10).

export type InstanceVerdict = { ok: true; origin: string } | { ok: false; reason: 'invalid' | 'https_required' };

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function checkInstanceUrl(input: string): InstanceVerdict {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return { ok: false, reason: 'invalid' };
  if (url.protocol === 'https:') return { ok: true, origin: url.origin };
  if (url.protocol === 'http:') return LOOPBACK.has(url.hostname) ? { ok: true, origin: url.origin } : { ok: false, reason: 'https_required' };
  return { ok: false, reason: 'invalid' };
}

/** Motif d'hôte de l'instance (permission demandée au clic « Appairer », pour joindre son API sans CORS). */
export function instancePattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}
