// SPDX-License-Identifier: AGPL-3.0-only
// Index des fichiers téléchargés d'une session : une ligne par artefact `download` (table `artifacts` de 0.2 : id, session,
// nom nettoyé, clé d'objet, taille, sha256, création, expiration). Le nœud écrit, l'API fichiers (passerelle, tâche 2.x) lit.
// Implémentation en mémoire ici ; l'implémentation PostgreSQL sur la table `artifacts` vient avec l'accès du nœud à la base
// (battement et sessions, tâche 1.2) : même interface.

export type FileRecord = {
  id: string;
  sessionId: string;
  tenantId: string;
  /** Nom nettoyé (`sanitizeFileName`). */
  name: string;
  size: number;
  sha256: string;
  objectKey: string;
  createdAt: Date;
  expiresAt: Date;
};

export interface FileIndex {
  insert(record: FileRecord): Promise<void>;
  /** Lignes de la session, expirées comprises (le filtre d'expiration appartient à l'appelant). */
  list(sessionId: string): Promise<FileRecord[]>;
  get(sessionId: string, id: string): Promise<FileRecord | undefined>;
  remove(sessionId: string, id: string): Promise<void>;
}

export class MemoryFileIndex implements FileIndex {
  readonly #rows = new Map<string, FileRecord>();

  insert(record: FileRecord): Promise<void> {
    this.#rows.set(record.id, { ...record });
    return Promise.resolve();
  }

  list(sessionId: string): Promise<FileRecord[]> {
    return Promise.resolve([...this.#rows.values()].filter((r) => r.sessionId === sessionId).map((r) => ({ ...r })));
  }

  get(sessionId: string, id: string): Promise<FileRecord | undefined> {
    const row = this.#rows.get(id);
    return Promise.resolve(row?.sessionId === sessionId ? { ...row } : undefined);
  }

  remove(sessionId: string, id: string): Promise<void> {
    if (this.#rows.get(id)?.sessionId === sessionId) this.#rows.delete(id);
    return Promise.resolve();
  }
}
