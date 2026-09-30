// Garde X6 : échec si un .py ou .ipynb est suivi par git (aucun Python dans le dépôt).
import { execFileSync } from 'node:child_process';

const out = execFileSync('git', ['ls-files', '*.py', '*.ipynb'], { encoding: 'utf8' }).trim();
if (out !== '') {
  console.error(`Garde X6 : fichiers Python ou notebook interdits :\n${out}`);
  process.exit(1);
}
console.log('Garde X6 : aucun .py ni .ipynb suivi.');
