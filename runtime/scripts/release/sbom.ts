// SPDX-License-Identifier: AGPL-3.0-only
// SBOM CycloneDX 1.7 (ECMA-424) du lockfile, généré par `pnpm sbom` (intégré à pnpm 11, aucune dépendance de plus), et
// contrôle de présence (assert_sbom_present). Le SBOM de l'image est produit par syft dans le workflow de release.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CYCLONEDX_SPEC = '1.7';

type Component = { type?: string; name?: string; version?: string; purl?: string; group?: string };
type Bom = { bomFormat?: string; specVersion?: string; serialNumber?: string; metadata?: { component?: { name?: string; version?: string } }; components?: Component[] };

/** Génère le SBOM (lockfile seul, développement compris, marqué `excluded`) ; `prod` : dépendances de production seulement. */
export function generateLockfileSbom(runtimeDir: string, outFile: string, options: { prod?: boolean } = {}): void {
  const args = ['sbom', '--sbom-format', 'cyclonedx', '--sbom-spec-version', CYCLONEDX_SPEC, '--lockfile-only', '--out', outFile];
  if (options.prod) args.push('--prod');
  execFileSync('pnpm', args, { cwd: runtimeDir, stdio: ['ignore', 'ignore', 'inherit'] });
}

/** Noms du catalogue pnpm-workspace.yaml : dépendances que le SBOM du lockfile doit citer. */
export function catalogNames(workspaceYaml: string): string[] {
  const names: string[] = [];
  let inCatalog = false;
  for (const raw of workspaceYaml.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (/^\S/.test(line)) inCatalog = /^catalog:\s*$/.test(line);
    else if (inCatalog) {
      const match = /^\s+(?:'([^']+)'|"([^"]+)"|([^\s:]+)):\s*\S/.exec(line);
      const name = match?.[1] ?? match?.[2] ?? match?.[3];
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

/**
 * Problèmes d'un SBOM : format et version de la spécification, identifiant de série, composants nommés, versionnés et
 * identifiés par purl, présence du composant racine, et — si `expectedNames` est fourni — de chaque dépendance déclarée.
 */
export function validateSbom(json: string, expectedNames: readonly string[] = []): string[] {
  let bom: Bom;
  try {
    bom = JSON.parse(json) as Bom;
  } catch {
    return ['SBOM : JSON illisible'];
  }
  const problems: string[] = [];
  if (bom.bomFormat !== 'CycloneDX') problems.push(`SBOM : bomFormat « ${bom.bomFormat ?? '(absent)'} », CycloneDX attendu`);
  if (bom.specVersion !== CYCLONEDX_SPEC) problems.push(`SBOM : specVersion « ${bom.specVersion ?? '(absente)'} », ${CYCLONEDX_SPEC} attendue`);
  if (!/^urn:uuid:[0-9a-f-]{36}$/.test(bom.serialNumber ?? '')) problems.push('SBOM : serialNumber (urn:uuid) absent ou invalide');
  if (!bom.metadata?.component?.name) problems.push('SBOM : composant racine (metadata.component) absent');
  const components = bom.components ?? [];
  if (components.length === 0) problems.push('SBOM : aucun composant');
  const bad = components.filter((c) => !c.name || !c.version || !c.purl?.startsWith('pkg:'));
  if (bad.length > 0) problems.push(`SBOM : ${bad.length} composant(s) sans nom, version ou purl (ex. ${bad[0]?.name ?? '?'})`);
  const present = new Set(components.map((c) => (c.group ? `${c.group}/${c.name}` : (c.name ?? ''))));
  const missing = expectedNames.filter((n) => !present.has(n));
  if (missing.length > 0) problems.push(`SBOM : dépendances déclarées absentes : ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
  return problems;
}

export function checkSbomFile(path: string, expectedNames: readonly string[] = []): string[] {
  try {
    return validateSbom(readFileSync(path, 'utf8'), expectedNames);
  } catch {
    return [`SBOM : fichier absent (${path})`];
  }
}

if (import.meta.main) {
  // `node scripts/release/sbom.ts <fichier.cdx.json>` : SBOM du lockfile, dépendances du catalogue comprises.
  const file = process.argv[2];
  if (file === undefined) {
    console.error('usage : node scripts/release/sbom.ts <fichier.cdx.json>');
    process.exit(2);
  }
  const names = catalogNames(readFileSync(new URL('../../pnpm-workspace.yaml', import.meta.url), 'utf8'));
  const problems = checkSbomFile(file, names);
  if (problems.length > 0) {
    console.error(`assert_sbom_present :\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`assert_sbom_present : ${file} (CycloneDX ${CYCLONEDX_SPEC}, ${names.length} dépendances du catalogue présentes).`);
}
