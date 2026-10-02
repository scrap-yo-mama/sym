// SPDX-License-Identifier: AGPL-3.0-only
// Lecture minimale de PNG et de GIF, sans dépendance (22 §3.3, 22b §3) : dimensions, opacité, marges, durée, métadonnées.
// Le job `vitrine` n'ajoute ni `sharp` ni `ffprobe` : ces contrôles ne demandent que l'en-tête et les pixels 8 bits.
import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type PngInfo = {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
  /** Un canal alpha existe (type 4 ou 6, ou bloc tRNS). */
  hasAlphaChannel: boolean;
  /** Blocs de texte (tEXt, iTXt, zTXt) : mot-clé et contenu. */
  text: { keyword: string; value: string }[];
  /** Blocs ancillaires présents (pour le contrôle des métadonnées). */
  chunks: string[];
  /** Données IDAT concaténées (compressées). */
  data: Buffer;
};

export function parsePng(buffer: Buffer): PngInfo {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('pas un PNG');
  let offset = 8;
  let info: Omit<PngInfo, 'text' | 'chunks' | 'data' | 'hasAlphaChannel'> | undefined;
  let trns = false;
  const text: PngInfo['text'] = [];
  const chunks: string[] = [];
  const idat: Buffer[] = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push(type);
    if (type === 'IHDR') {
      info = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), bitDepth: body[8] ?? 0, colorType: body[9] ?? 0, interlace: body[12] ?? 0 };
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'tRNS') trns = true;
    else if (type === 'tEXt') {
      const zero = body.indexOf(0);
      text.push({ keyword: body.toString('latin1', 0, zero), value: body.toString('latin1', zero + 1) });
    } else if (type === 'iTXt' || type === 'zTXt') {
      const zero = body.indexOf(0);
      text.push({ keyword: body.toString('latin1', 0, zero), value: body.toString('utf8', zero + 1) });
    }
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  if (!info) throw new Error('PNG sans IHDR');
  return { ...info, hasAlphaChannel: info.colorType === 4 || info.colorType === 6 || trns, text, chunks, data: Buffer.concat(idat) };
}

/** Pixels RGBA 8 bits d'un PNG non entrelacé (types 0, 2, 4, 6 ; indexé non géré). */
export function decodePng(buffer: Buffer): { width: number; height: number; rgba: Uint8Array } {
  const png = parsePng(buffer);
  if (png.bitDepth !== 8 || png.interlace !== 0 || ![0, 2, 4, 6].includes(png.colorType)) {
    throw new Error(`PNG non géré (profondeur ${png.bitDepth}, type ${png.colorType}, entrelacement ${png.interlace})`);
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[png.colorType] as number;
  const stride = png.width * channels;
  const raw = inflateSync(png.data);
  const out = new Uint8Array(png.width * png.height * 4);
  let previous = new Uint8Array(stride);
  let current = new Uint8Array(stride);
  for (let y = 0; y < png.height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? (current[i - channels] ?? 0) : 0;
      const up = previous[i] ?? 0;
      const upLeft = i >= channels ? (previous[i - channels] ?? 0) : 0;
      const value = line[i] ?? 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      current[i] = (value + predicted) & 0xff;
    }
    for (let x = 0; x < png.width; x += 1) {
      const target = (y * png.width + x) * 4;
      const base = x * channels;
      if (png.colorType === 0 || png.colorType === 4) {
        const g = current[base] ?? 0;
        out.set([g, g, g, png.colorType === 4 ? (current[base + 1] ?? 255) : 255], target);
      } else {
        out.set([current[base] ?? 0, current[base + 1] ?? 0, current[base + 2] ?? 0, png.colorType === 6 ? (current[base + 3] ?? 255) : 255], target);
      }
    }
    [previous, current] = [current, previous];
  }
  return { width: png.width, height: png.height, rgba: out };
}

/** Opaque : aucun canal alpha, ou alpha partout à 255. */
export function isOpaque(buffer: Buffer): boolean {
  const png = parsePng(buffer);
  if (!png.hasAlphaChannel) return true;
  const { rgba } = decodePng(buffer);
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return false;
  return true;
}

/** Couleur (RRGGBB) de chaque pixel de la marge `margin` (px) qui diffère de `background`, au plus `limit` signalés. */
export function marginViolations(buffer: Buffer, background: string, margin: number, limit = 5): { x: number; y: number; color: string }[] {
  const { width, height, rgba } = decodePng(buffer);
  const found: { x: number; y: number; color: string }[] = [];
  const want = background.replace('#', '').toLowerCase();
  for (let y = 0; y < height && found.length < limit; y += 1) {
    for (let x = 0; x < width && found.length < limit; x += 1) {
      if (x >= margin && x < width - margin && y >= margin && y < height - margin) {
        // Intérieur : saute directement au bord droit de la zone libre.
        x = width - margin - 1;
        continue;
      }
      const i = (y * width + x) * 4;
      const color = [rgba[i], rgba[i + 1], rgba[i + 2]].map((v) => (v ?? 0).toString(16).padStart(2, '0')).join('');
      if (color !== want) found.push({ x, y, color });
    }
  }
  return found;
}

export type GifInfo = { width: number; height: number; frames: number; durationSeconds: number };

/** Dimensions, nombre d'images et durée d'un GIF (délais des blocs de contrôle graphique ; 10 ms par unité). */
export function parseGif(buffer: Buffer): GifInfo {
  const header = buffer.toString('latin1', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') throw new Error('pas un GIF');
  const width = buffer.readUInt16LE(6);
  const height = buffer.readUInt16LE(8);
  const packed = buffer[10] ?? 0;
  let offset = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  let frames = 0;
  let delay = 0;
  let pendingDelay = 0;
  while (offset < buffer.length) {
    const block = buffer[offset];
    if (block === 0x3b) break;
    if (block === 0x21) {
      const label = buffer[offset + 1];
      if (label === 0xf9) pendingDelay = buffer.readUInt16LE(offset + 4);
      offset += 2;
      while ((buffer[offset] ?? 0) !== 0) offset += (buffer[offset] ?? 0) + 1;
      offset += 1;
    } else if (block === 0x2c) {
      frames += 1;
      delay += pendingDelay;
      pendingDelay = 0;
      const imagePacked = buffer[offset + 9] ?? 0;
      offset += 10 + (imagePacked & 0x80 ? 3 * 2 ** ((imagePacked & 7) + 1) : 0) + 1;
      while ((buffer[offset] ?? 0) !== 0) offset += (buffer[offset] ?? 0) + 1;
      offset += 1;
    } else throw new Error(`bloc GIF inattendu 0x${(block ?? 0).toString(16)}`);
  }
  return { width, height, frames, durationSeconds: delay / 100 };
}
