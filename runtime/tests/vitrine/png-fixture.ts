// SPDX-License-Identifier: AGPL-3.0-only
// Fabrique de PNG synthétiques pour les cas négatifs des tests de visuels (aucun fichier du dépôt n'est modifié).
import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

export type PngOptions = {
  width: number;
  height: number;
  /** Couleur de fond RRGGBB. */
  background?: string;
  /** Pixels à peindre d'une autre couleur : x, y, RRGGBB. */
  paint?: [number, number, string][];
  /** Canal alpha (type 6) avec cette valeur partout, ou aucun (type 2). */
  alpha?: number;
  /** Blocs de texte ajoutés : mot-clé, valeur. */
  text?: [string, string][];
  /** Octets aléatoires ajoutés dans un bloc privé pour gonfler le fichier. */
  padding?: number;
};

export function makePng(options: PngOptions): Buffer {
  const { width, height, alpha } = options;
  const channels = alpha === undefined ? 3 : 4;
  const bg = (options.background ?? 'FFFFFF').match(/../g)?.map((h) => parseInt(h, 16)) ?? [255, 255, 255];
  const raw = Buffer.alloc(height * (1 + width * channels));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * channels);
    for (let x = 0; x < width; x += 1) {
      raw.set(bg, row + 1 + x * channels);
      if (alpha !== undefined) raw[row + 1 + x * channels + 3] = alpha;
    }
  }
  for (const [x, y, color] of options.paint ?? []) {
    const offset = y * (1 + width * channels) + 1 + x * channels;
    raw.set(color.match(/../g)?.map((h) => parseInt(h, 16)) ?? [0, 0, 0], offset);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = alpha === undefined ? 2 : 6;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header)];
  for (const [keyword, value] of options.text ?? []) parts.push(chunk('tEXt', Buffer.from(`${keyword}\0${value}`, 'latin1')));
  parts.push(chunk('IDAT', deflateSync(raw)));
  if (options.padding) parts.push(chunk('prVt', Buffer.alloc(options.padding, 7)));
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}
