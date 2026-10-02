// SPDX-License-Identifier: AGPL-3.0-only
// Étoiles et dernière version du dépôt public, écrites dans landing/stars.json AU BUILD (jamais demandées par le navigateur). La
// dernière valeur est gardée si l'API GitHub échoue. Lecture seule de l'API publique (jeton facultatif GITHUB_TOKEN, en lecture).
//   node scripts/landing-stars.ts
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseStars } from '../src/landing/checks.ts';
import { publicRepository } from '../src/landing/identity.ts';
import { readStars, STARS_FILE } from '../src/landing/site.ts';

const repository = publicRepository();
const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'user-agent': 'scrapyomama-landing-build' };
if (process.env['GITHUB_TOKEN']) headers['authorization'] = `Bearer ${process.env['GITHUB_TOKEN']}`;
const get = async (path: string): Promise<unknown> => {
  try {
    const response = await fetch(`https://api.github.com/repos/${repository}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
    return response.ok ? ((await response.json()) as unknown) : null;
  } catch {
    return null;
  }
};
const next = parseStars(readStars(), await get(''), await get('/releases/latest'));
writeFileSync(fileURLToPath(STARS_FILE), `${JSON.stringify(next, null, 2)}\n`);
console.log(`landing/stars.json : ${next.stars} étoile(s), version ${next.version ?? 'aucune'}.`);
