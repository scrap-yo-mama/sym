// SPDX-License-Identifier: AGPL-3.0-only
// Clé de cadence : le domaine enregistrable de la cible, rien d'autre (assert_pacing_key_is_domain, 17 § cadence).
// Ni l'URL, ni l'API, ni l'utilisateur, ni le proxy, ni l'IP de sortie, ni le jeton de tunnel n'y entrent.
//
// APPROXIMATION DOCUMENTÉE : sans liste des suffixes publics (aucune dépendance ajoutée, contrainte de la tâche 1.9),
// on garde les deux derniers libellés, trois quand le dernier est un code pays de deux lettres précédé d'un libellé
// générique usuel (`co.uk`, `com.au`, `gouv.fr`...). Un suffixe privé (`github.io`, `herokuapp.com`) n'est pas reconnu :
// les sous-domaines de tels hébergeurs partagent donc une cadence. L'erreur va dans le sens poli (trop lent, jamais
// trop rapide). Écart à lever avec une vraie liste des suffixes publics si le CDC l'exige.

const GENERIC_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'gouv', 'edu', 'ac', 'or', 'ne', 'go', 'asso', 'nom']);

export class PacingKeyError extends Error {
  constructor(input: string) {
    super(`cadence : domaine introuvable dans « ${input.slice(0, 80)} »`);
    this.name = 'PacingKeyError';
  }
}

function hostnameOf(input: string): string {
  const trimmed = input.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    // `URL` normalise la casse, l'IDN (punycode) et retire le port et les identifiants.
    return new URL(candidate).hostname;
  } catch {
    throw new PacingKeyError(input);
  }
}

/** Domaine enregistrable (approché) d'une URL ou d'un nom d'hôte. Les adresses IP sont gardées telles quelles. */
export function registrableDomain(urlOrHost: string): string {
  let host = hostnameOf(urlOrHost).toLowerCase().replace(/\.$/, '');
  if (host === '') throw new PacingKeyError(urlOrHost);
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  host = host.replace(/^www\d*\./, '');
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const last = labels[labels.length - 1] as string;
  const second = labels[labels.length - 2] as string;
  const keep = last.length === 2 && GENERIC_SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-keep).join('.');
}
