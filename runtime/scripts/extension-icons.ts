// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 2.9 : icônes de l'extension (Chrome Web Store : 128 px obligatoire ; 16, 32 et 48 pour la barre d'outils et la
// page des extensions) et vignette promotionnelle du Store (440 × 280). Générées sans dépendance (encodeur PNG sur node:zlib), de façon déterministe : un nœud et un
// lien sur fond arrondi. `node scripts/extension-icons.ts` réécrit les fichiers, `--check` échoue s'ils diffèrent.
import { deflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ICON_SIZES = [16, 32, 48, 128] as const;
const OUT = new URL('../apps/extension/public/icons/', import.meta.url).pathname;
const PROMO_OUT = new URL('../apps/extension/store/assets/', import.meta.url).pathname;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Distance signée à un rectangle arrondi centré (négative à l'intérieur). */
function roundedBox(x: number, y: number, half: number, radius: number): number {
  const qx = Math.abs(x) - (half - radius);
  const qy = Math.abs(y) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}
/** Distance signée à un segment épaissi. */
function segment(px: number, py: number, ax: number, ay: number, bx: number, by: number, w: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) - w;
}

const BG: readonly [number, number, number] = [0x0f, 0x4c, 0x5c];
const FG: readonly [number, number, number] = [0xff, 0xff, 0xff];

/** Couleur RGBA d'un point en coordonnées de -1 à 1. */
function sample(x: number, y: number): [number, number, number, number] {
  if (roundedBox(x, y, 1, 0.42) > 0) return [0, 0, 0, 0];
  const nodes: [number, number, number][] = [[-0.42, 0.38, 0.2], [0.44, -0.38, 0.2]];
  const link = segment(x, y, -0.42, 0.38, 0.44, -0.38, 0.07);
  const ring = nodes.some(([cx, cy, r]) => Math.hypot(x - cx, y - cy) < r);
  return link < 0 || ring ? [...FG, 255] : [...BG, 255];
}

type Sampler = (x: number, y: number) => [number, number, number, number];

/** PNG `width` × `height` ; `sampler` reçoit des pixels fractionnaires et rend un RGBA (suréchantillonnage 4 × 4). `opaque` : RGB 24 bits sans alpha (exigé pour les images du Store). */
function rasterize(width: number, height: number, sampler: Sampler, opaque = false): Buffer {
  const SS = 4;
  const bpp = opaque ? 3 : 4;
  const stride = width * bpp + 1;
  const raw = Buffer.alloc(stride * height);
  for (let py = 0; py < height; py++) {
    raw[py * stride] = 0; // filtre « none »
    for (let px = 0; px < width; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = sampler(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca;
        }
      }
      const o = py * stride + 1 + px * bpp;
      raw[o] = a === 0 ? 0 : Math.round(r / a);
      raw[o + 1] = a === 0 ? 0 : Math.round(g / a);
      raw[o + 2] = a === 0 ? 0 : Math.round(b / a);
      if (!opaque) raw[o + 3] = Math.round(a / (SS * SS));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, opaque ? 2 : 6, 0, 0, 0], 8); // 8 bits, RGB ou RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function renderIcon(size: number): Buffer {
  return rasterize(size, size, (px, py) => sample((px / size) * 2 - 1, (py / size) * 2 - 1));
}

/** Petite vignette promotionnelle du Store (440 × 280, obligatoire) : l'icône centrée sur fond clair, sans texte. */
export const PROMO = { width: 440, height: 280, file: 'promo-small-440x280.png' } as const;
export function renderPromo(): Buffer {
  const icon = 176;
  const left = (PROMO.width - icon) / 2;
  const top = (PROMO.height - icon) / 2;
  return rasterize(PROMO.width, PROMO.height, (px, py) => {
    const inside = px >= left && px < left + icon && py >= top && py < top + icon;
    if (!inside) return [0xe8, 0xf1, 0xf3, 255];
    const [r, g, b, a] = sample(((px - left) / icon) * 2 - 1, ((py - top) / icon) * 2 - 1);
    return a === 0 ? [0xe8, 0xf1, 0xf3, 255] : [r, g, b, a];
  }, true);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const check = process.argv.includes('--check');
  const targets: [string, Buffer][] = [
    ...ICON_SIZES.map((size): [string, Buffer] => [join(OUT, `${size}.png`), renderIcon(size)]),
    [join(PROMO_OUT, PROMO.file), renderPromo()],
  ];
  let stale = 0;
  for (const [file, png] of targets) {
    if (check) {
      let current: Buffer | null = null;
      try { current = readFileSync(file); } catch { /* absent */ }
      if (current === null || !current.equals(png)) { console.error(`image périmée : ${file}`); stale++; }
    } else {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, png);
    }
  }
  if (stale > 0) process.exit(1);
  console.log(check ? 'images à jour' : `${targets.length} images écrites`);
}
