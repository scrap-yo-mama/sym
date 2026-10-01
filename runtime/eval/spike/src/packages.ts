// Critère 3.3 du §9 (simplicité) : nombre de paquets distincts que le moteur ajoute à l'arbre de production
// (nom@version, dépendances transitives comprises), lu par `pnpm list --prod`.
import { execFileSync } from 'node:child_process';

interface ListNode {
  version?: string;
  dependencies?: Record<string, ListNode>;
}

function walk(name: string, node: ListNode, seen: Set<string>): void {
  const key = `${name}@${node.version ?? '?'}`;
  if (seen.has(key)) return;
  seen.add(key);
  for (const [child, sub] of Object.entries(node.dependencies ?? {})) walk(child, sub, seen);
}

/** Paquets distincts du sous-arbre `root` dans le paquet de l'espace de travail `filter`. */
export function subtreePackages(cwd: string, filter: string, root: string): number {
  const out = execFileSync('pnpm', ['list', '--filter', filter, '--prod', '--depth', 'Infinity', '--json'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const [project] = JSON.parse(out) as { dependencies?: Record<string, ListNode> }[];
  const node = project?.dependencies?.[root];
  if (node === undefined) return 0;
  const seen = new Set<string>();
  walk(root, node, seen);
  return seen.size;
}
