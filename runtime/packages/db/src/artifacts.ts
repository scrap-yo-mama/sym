// SPDX-License-Identifier: AGPL-3.0-only
// Artefacts de run (INV8, 14 § 10) : niveau 0 par défaut (aucune ligne), sinon texte masqué par `redactArtifactText`
// puis chiffré AES-256-GCM (DEK/KEK, AAD liée au run et au propriétaire). `rekey` les couvre (secrets.ts).
import { randomUUID } from 'node:crypto';
import {
  artifactAad,
  artifactDenial,
  kekFor,
  openSecretBytes,
  redactArtifactText,
  sealSecret,
  secretValues,
  type ArtifactDenial,
  type ArtifactKind,
  type ArtifactLevel,
  type ArtifactRunFlags,
  type Keyring,
  type SecretValueRegistry,
} from '@runtime/core';
import type pg from 'pg';
import { KEY_CHECK_SETTING, REKEY_STATE_SETTING, RekeyInProgressError, type KeyCheckResult } from './secrets.js';

type Queryable = Pick<pg.ClientBase, 'query'>;

export type ArtifactSettings = { level: ArtifactLevel; maxBytes: number; quotaBytes: number };

export type ArtifactInput = {
  runId: string;
  ownerId: string;
  kind: ArtifactKind;
  /** `screenshot` : octets de l'image (non masquables, marqués `image_unredacted`) ; `trace` et `har` : texte. */
  content: string | Buffer;
  /** Issue du run et drapeaux d'exclusion OBLIGATOIRES (session serveur, tunnel, défi) : refus si l'un manque. */
  run: { failed: boolean } & ArtifactRunFlags;
  projectId?: string;
};

/** Artefact marqué illisible par `rekey` (ancienne clé perdue ou ligne altérée) : signalé, jamais présenté comme vide. */
export class ArtifactUnreadableError extends Error {
  override name = 'ArtifactUnreadableError';
  readonly artifactId: string;
  constructor(artifactId: string) {
    super(`artefact ${artifactId} illisible (état unreadable, marqué par rekey)`);
    this.artifactId = artifactId;
  }
}

export type ArtifactResult = { stored: true; id: string; bytes: number } | { stored: false; reason: ArtifactDenial | 'too_large' | 'quota' };

/** Enregistre un artefact si la politique l'autorise. Niveau `none` : retour immédiat, sans aucun accès à la base. */
export async function writeRunArtifact(
  db: Queryable,
  keyring: Keyring,
  checked: KeyCheckResult,
  settings: ArtifactSettings,
  input: ArtifactInput,
  registry: SecretValueRegistry = secretValues,
): Promise<ArtifactResult> {
  const denial = artifactDenial(settings.level, input.kind, input.run);
  if (denial) return { stored: false, reason: denial };

  const isImage = input.kind === 'screenshot';
  const plaintext = isImage
    ? Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content)
    : Buffer.from(redactArtifactText(input.content.toString(), registry), 'utf8');
  if (plaintext.length > settings.maxBytes) return { stored: false, reason: 'too_large' };
  const { rows } = await db.query<{ used: string }>('SELECT coalesce(sum(bytes), 0)::text AS used FROM run_artifacts');
  if (Number(rows[0]?.used ?? 0) + plaintext.length > settings.quotaBytes) return { stored: false, reason: 'quota' };

  const id = randomUUID();
  const sealed = sealSecret(plaintext, kekFor(keyring.current, checked.version), artifactAad({ id, runId: input.runId, ownerId: input.ownerId, kind: input.kind }));
  // Même garde atomique que `secretStore.put` : pas d'écriture pendant une rotation ni sous une version de clé périmée.
  const { rowCount } = await db.query(
    `INSERT INTO run_artifacts (id, run_id, owner_id, project_id, kind, bytes, sensitivity, ciphertext, nonce, dek_wrapped, alg, key_version)
     SELECT $1, $2, $3, coalesce($4::uuid, '00000000-0000-0000-0000-000000000001'), $5, $6, $7, $8, $9, $10, $11, $12
     WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = '${REKEY_STATE_SETTING}')
       AND EXISTS (SELECT 1 FROM settings WHERE key = '${KEY_CHECK_SETTING}' AND (value ->> 'version')::int = $12)`,
    [
      id,
      input.runId,
      input.ownerId,
      input.projectId ?? null,
      input.kind,
      plaintext.length,
      isImage ? 'image_unredacted' : 'text_redacted',
      sealed.ciphertext,
      sealed.nonce,
      sealed.dekWrapped,
      sealed.alg,
      sealed.kekVersion,
    ],
  );
  if (rowCount !== 1) throw new RekeyInProgressError('écriture d’artefact refusée : rotation de clé en cours ou terminée depuis le démarrage de ce processus.');
  return { stored: true, id, bytes: plaintext.length };
}

/**
 * Ouvre un artefact (AAD recalculée depuis la ligne). `null` si absent ; `ArtifactUnreadableError` s'il est marqué
 * illisible ; `SecretDecryptError` si altéré ou autre clé.
 */
export async function readRunArtifact(
  db: Queryable,
  keyring: Keyring,
  checked: KeyCheckResult,
  id: string,
): Promise<{ kind: ArtifactKind; content: Buffer } | null> {
  const { rows } = await db.query<{
    id: string;
    run_id: string;
    owner_id: string;
    kind: ArtifactKind;
    ciphertext: Buffer;
    nonce: Buffer;
    dek_wrapped: Buffer;
    alg: string;
    key_version: number;
    state: 'ok' | 'unreadable';
  }>('SELECT id, run_id, owner_id, kind, ciphertext, nonce, dek_wrapped, alg, key_version, state FROM run_artifacts WHERE id = $1', [id]);
  const row = rows[0];
  if (!row) return null;
  if (row.state === 'unreadable') throw new ArtifactUnreadableError(row.id);
  const aad = artifactAad({ id: row.id, runId: row.run_id, ownerId: row.owner_id, kind: row.kind });
  const content = openSecretBytes(
    { ciphertext: row.ciphertext, nonce: row.nonce, dekWrapped: row.dek_wrapped, alg: row.alg, kekVersion: row.key_version },
    kekFor(keyring.current, checked.version),
    aad,
  );
  return { kind: row.kind, content };
}
