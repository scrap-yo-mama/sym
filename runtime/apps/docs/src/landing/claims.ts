// SPDX-License-Identifier: AGPL-3.0-only
// Registre des allégations (22 § 3.2) : `.github/claims.json`, source unique de chaque phrase factuelle de la landing. Lu au
// build ; une entrée « à relire » ou « bloqué » ne s'affiche jamais (le test assert_landing_claims_sourced le vérifie sur le
// HTML construit, et `resolveClaim` refuse de la rendre).
import { readFileSync } from 'node:fs';
import type { Lang } from './types.ts';

type ClaimStatus = 'relu' | 'à relire' | 'bloqué';

type Claim = {
  id: string;
  fr: string;
  en: string;
  /** `test:<nom>`, `inv:<INV>`, `file:<chemin depuis la racine du dépôt>`, `page:<page du site de doc>`, `decision:<D-n>`. */
  proof: string[];
  reviewed: string;
  status: ClaimStatus;
  tasks?: string[];
  surfaces?: string[];
  note?: string;
};

export type ClaimsRegistry = { version: number; claims: Claim[] };

const CLAIMS_URL = new URL('../../../../../.github/claims.json', import.meta.url);

export function loadClaims(url: URL = CLAIMS_URL): ClaimsRegistry {
  const registry = JSON.parse(readFileSync(url, 'utf8')) as ClaimsRegistry;
  const ids = new Set<string>();
  for (const claim of registry.claims) {
    if (ids.has(claim.id)) throw new Error(`claims.json : identifiant en double « ${claim.id} »`);
    ids.add(claim.id);
    if (!['relu', 'à relire', 'bloqué'].includes(claim.status)) throw new Error(`claims.json : statut inconnu pour « ${claim.id} »`);
  }
  return registry;
}

/** Texte d'une entrée dans une langue ; échoue si l'entrée est absente ou n'est pas « relu » : elle ne s'affiche pas. */
export function resolveClaim(registry: ClaimsRegistry, id: string, lang: Lang): string {
  const claim = registry.claims.find((c) => c.id === id);
  if (!claim) throw new Error(`allégation absente du registre : « ${id} »`);
  if (claim.status !== 'relu') throw new Error(`allégation « ${id} » au statut « ${claim.status} » : elle ne s'affiche pas`);
  return claim[lang];
}

/** Compare deux textes comme le font les tests : casse conservée, espaces (insécables comprises) repliées. */
export const normalizeText = (text: string): string => text.replace(/[\s\u00a0\u202f]+/g, ' ').trim();
