// SPDX-License-Identifier: AGPL-3.0-only
// Clés d'objets (cdc/sym-browser 03 § 5 et § 6, 04c § 4) : `profiles/{tenantId}/{profileId}/v{n}` et
// `artifacts/{type}/{tenantId}/{sessionId}/{artifactId}`. Chaque composant est un identifiant sûr (ni `.`, ni `/`, ni `|`),
// donc aucune clé ne sort de son préfixe ni ne rend une AAD ambiguë. L'AAD d'un objet se recalcule depuis sa clé.
import { buildAad, profileAad } from '../crypto/envelope.js';

/** Types d'artefacts de la table `artifacts` (03 § 5). Les profils ne sont pas des artefacts : jamais purgés. */
export const ARTIFACT_KINDS = ['trace', 'har', 'video', 'console', 'network', 'download'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export type ParsedObjectKey =
  | { type: 'profile'; tenantId: string; profileId: string; version: number }
  | { type: 'artifact'; kind: ArtifactKind; tenantId: string; sessionId: string; artifactId: string };

export class InvalidObjectKeyError extends Error {
  override name = 'InvalidObjectKeyError';
  constructor(detail: string) {
    super(`clé d’objet invalide : ${detail}`);
  }
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const VERSION = /^v(0|[1-9][0-9]{0,15})$/;

function segment(value: string, name: string): string {
  if (!SEGMENT.test(value)) throw new InvalidObjectKeyError(`${name} hors format (lettres, chiffres, « - », « _ »)`);
  return value;
}

function version(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new InvalidObjectKeyError('version de profil hors format');
  return value;
}

export function isArtifactKind(value: string): value is ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(value);
}

export function profileObjectKey(row: { tenantId: string; profileId: string; version: number }): string {
  return `profiles/${segment(row.tenantId, 'tenantId')}/${segment(row.profileId, 'profileId')}/v${version(row.version)}`;
}

export function artifactObjectKey(row: { kind: ArtifactKind; tenantId: string; sessionId: string; artifactId: string }): string {
  if (!isArtifactKind(row.kind)) throw new InvalidObjectKeyError('type d’artefact inconnu');
  return `artifacts/${row.kind}/${segment(row.tenantId, 'tenantId')}/${segment(row.sessionId, 'sessionId')}/${segment(row.artifactId, 'artifactId')}`;
}

/** Analyse stricte : toute clé qui n'est pas exactement produite par les deux fonctions ci-dessus est refusée. */
export function parseObjectKey(key: string): ParsedObjectKey {
  const parts = key.split('/');
  if (parts[0] === 'profiles' && parts.length === 4) {
    const [, tenantId = '', profileId = '', v = ''] = parts;
    if (!VERSION.test(v)) throw new InvalidObjectKeyError('version de profil hors format');
    const parsed = { type: 'profile' as const, tenantId: segment(tenantId, 'tenantId'), profileId: segment(profileId, 'profileId'), version: version(Number(v.slice(1))) };
    return parsed;
  }
  if (parts[0] === 'artifacts' && parts.length === 5) {
    const [, kind = '', tenantId = '', sessionId = '', artifactId = ''] = parts;
    if (!isArtifactKind(kind)) throw new InvalidObjectKeyError('type d’artefact inconnu');
    return { type: 'artifact', kind, tenantId: segment(tenantId, 'tenantId'), sessionId: segment(sessionId, 'sessionId'), artifactId: segment(artifactId, 'artifactId') };
  }
  throw new InvalidObjectKeyError('préfixe ou nombre de composants inattendu');
}

/** Valide une clé et la rend telle quelle (refus avant tout accès au stockage). */
export function assertObjectKey(key: string): string {
  parseObjectKey(key);
  return key;
}

/** AAD d'un objet : celle de 0.3 pour un profil (`profile|tenant|profil|version`), `artifact|type|tenant|session|id` sinon. */
export function objectAad(key: string): string {
  const parsed = parseObjectKey(key);
  if (parsed.type === 'profile') return profileAad(parsed);
  return buildAad(['artifact', parsed.kind, parsed.tenantId, parsed.sessionId, parsed.artifactId]);
}
