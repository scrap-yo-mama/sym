// Empreinte SHA-256 du protocole du spike 0.6a (15 §11 : « empreinte vérifiée en CI »).
// Usage : node eval/scripts/spike-decision-hash.ts          -> affiche l'empreinte
//         node eval/scripts/spike-decision-hash.ts --check  -> code 1 si l'empreinte stockée diffère
//         node eval/scripts/spike-decision-hash.ts --write  -> met à jour l'empreinte stockée
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DECISION_FILE = 'spike-0.6a-decision.md';
export const DECISION_PATH = fileURLToPath(new URL(`../${DECISION_FILE}`, import.meta.url));
export const HASH_PATH = fileURLToPath(new URL('../spike-0.6a-decision.sha256', import.meta.url));

/** SHA-256 hexadécimal des octets bruts (aucune normalisation : un changement de fin de ligne compte). */
export function sha256Hex(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Ligne au format `sha256sum` : `<hex>  <nom>\n`. */
export function formatHashLine(hex: string, name: string = DECISION_FILE): string {
  return `${hex}  ${name}\n`;
}

/** Lit l'empreinte d'une ligne `sha256sum` ; `null` si le format est invalide. */
export function parseHashLine(line: string): { hex: string; name: string } | null {
  const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line.trim());
  return match ? { hex: match[1] as string, name: match[2] as string } : null;
}

export function computeDecisionHash(path: string = DECISION_PATH): string {
  return sha256Hex(readFileSync(path));
}

export function readStoredHash(path: string = HASH_PATH): { hex: string; name: string } | null {
  return parseHashLine(readFileSync(path, 'utf8'));
}

if (import.meta.main) {
  const actual = computeDecisionHash();
  const mode = process.argv[2];
  if (mode === '--write') {
    writeFileSync(HASH_PATH, formatHashLine(actual));
    console.log(`Empreinte écrite : ${actual}`);
  } else if (mode === '--check') {
    const stored = readStoredHash();
    if (stored?.hex !== actual || stored.name !== DECISION_FILE) {
      console.error(`Empreinte du protocole 0.6a différente : stockée ${stored?.hex ?? 'illisible'}, calculée ${actual}.`);
      process.exit(1);
    }
    console.log(`Empreinte du protocole 0.6a conforme : ${actual}`);
  } else {
    console.log(actual);
  }
}
