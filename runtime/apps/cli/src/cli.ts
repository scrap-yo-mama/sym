import { readFileSync } from 'node:fs';

function version(): string {
  const url = new URL('../package.json', import.meta.url);
  return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
}

export function run(argv: string[]): { code: number; out: string } {
  const [cmd] = argv;
  if (cmd === '--version' || cmd === '-v') return { code: 0, out: version() };
  return { code: 1, out: 'Usage : runtime --version' };
}
