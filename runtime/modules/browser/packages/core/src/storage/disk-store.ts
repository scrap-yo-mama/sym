// SPDX-License-Identifier: AGPL-3.0-only
// Stockage brut `disk` (cdc/sym-browser 03 § 6, mode `all`, `OBJECT_DIR`) : un fichier par objet sous la racine, chemin =
// composants de la clé. Écriture atomique (fichier temporaire caché dans le même répertoire, fsync, renommage), fichiers
// 0600 et répertoires 0700. La date de dernière modification du fichier sert à la purge.
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { assertObjectKey } from './keys.js';
import { type BlobInfo, type BlobStore, checkPrefix, ObjectNotFoundError } from './object-store.js';

const isEnoent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

export class DiskBlobStore implements BlobStore {
  readonly type = 'disk' as const;
  readonly #root: string;

  constructor(root: string) {
    if (!isAbsolute(root)) throw new Error('OBJECT_DIR : chemin absolu attendu');
    this.#root = root;
  }

  #path(key: string): string {
    return join(this.#root, ...assertObjectKey(key).split('/'));
  }

  async put(key: string, body: AsyncIterable<Buffer>): Promise<number> {
    const path = this.#path(key);
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${key.split('/').at(-1)}.${randomBytes(6).toString('hex')}.tmp`);
    let bytes = 0;
    try {
      const out = createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
      await pipeline(
        body,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const part of source) {
            bytes += part.length;
            yield part;
          }
        },
        out,
      );
      const handle = await open(tmp, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, path);
      return bytes;
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Readable> {
    try {
      const handle = await open(this.#path(key), 'r');
      return handle.createReadStream();
    } catch (error) {
      if (isEnoent(error)) throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.#path(key), { force: true });
  }

  async *list(prefix: string): AsyncGenerator<BlobInfo> {
    checkPrefix(prefix);
    // Répertoire le plus profond entièrement désigné par le préfixe, puis parcours trié (ordre lexicographique des clés).
    const parts = prefix.split('/');
    const dirParts = parts.slice(0, -1);
    yield* this.#walk(dirParts, prefix);
  }

  async *#walk(parts: string[], prefix: string): AsyncGenerator<BlobInfo> {
    let entries;
    try {
      entries = await readdir(join(this.#root, ...parts), { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) return;
      throw error;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const key = [...parts, entry.name].join('/');
      if (entry.isDirectory()) {
        if (key.startsWith(prefix) || prefix.startsWith(`${key}/`)) yield* this.#walk([...parts, entry.name], prefix);
      } else if (entry.isFile() && key.startsWith(prefix)) {
        try {
          const info = await stat(join(this.#root, ...parts, entry.name));
          yield { key, size: info.size, lastModified: info.mtime };
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
      }
    }
  }
}
