// Empreinte de forme (`expect.shape_fingerprint`) : hash des CHEMINS et des TYPES d'un document, jamais des valeurs.
import { createHash } from 'node:crypto';

const MAX_PATHS = 5_000;
const MAX_DEPTH = 32;

function typeOf(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
}

/** `sha256:<hex>` de l'ensemble trié des `chemin:type` (les éléments d'un tableau sont fusionnés sous `[]`). */
export function shapeFingerprint(document: unknown): string {
  const seen = new Set<string>();
  const stack: [unknown, string, number][] = [[document, '$', 0]];
  while (stack.length > 0 && seen.size < MAX_PATHS) {
    const [value, path, depth] = stack.pop() as [unknown, string, number];
    seen.add(`${path}:${typeOf(value)}`);
    if (depth >= MAX_DEPTH || typeof value !== 'object' || value === null) continue;
    if (Array.isArray(value)) for (const item of value.slice(0, 50)) stack.push([item, `${path}[]`, depth + 1]);
    else for (const [k, v] of Object.entries(value)) stack.push([v, `${path}.${k}`, depth + 1]);
  }
  const digest = createHash('sha256').update([...seen].sort().join('\n')).digest('hex');
  return `sha256:${digest}`;
}
