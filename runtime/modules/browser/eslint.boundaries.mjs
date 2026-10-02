// SPDX-License-Identifier: AGPL-3.0-only
// Frontière du module SYM Browser (ADR 23 § 2 et § 3 ; cdc/sym-browser 03 § 9), en lint bloquant : un fichier du module
// n'importe, hors du module, que `@sym/contracts/browser` et `@runtime/ui` (packages/ui). Refusés : tout autre paquet du
// dépôt (`@runtime/*`, `@sym/*`), tout autre sous-chemin de `@sym/contracts`, et tout chemin relatif ou absolu qui sort de
// `modules/browser/` (contournement par chemin). Les paquets npm tiers et les modules intégrés de Node restent permis.
// Règle locale, sans dépendance : elle voyage avec le module (miroir public, tâche 5.8).
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));

/** Spécificateurs de paquets du dépôt admis depuis le module (exacts, ou préfixes suivis de `/`). */
const ALLOWED_EXACT = new Set(['@sym/contracts/browser', '@runtime/ui']);
const ALLOWED_PREFIXES = ['@runtime/ui/'];
/** Espaces de noms des paquets du dépôt hors module. */
const REPO_SCOPES = ['@runtime/', '@sym/'];

/**
 * Motif de refus d'un import, ou `undefined` s'il est permis. `file` : chemin absolu du fichier qui importe.
 * @param {string} specifier
 * @param {string} file
 * @returns {string | undefined}
 */
export function boundaryViolation(specifier, file) {
  if (specifier.startsWith('.') || isAbsolute(specifier) || specifier.startsWith('file:')) {
    const target = specifier.startsWith('file:') ? fileURLToPath(specifier) : resolve(dirname(file), specifier);
    const rel = relative(MODULE_ROOT, target);
    return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? `chemin hors de modules/browser/ (${specifier})` : undefined;
  }
  if (specifier.startsWith('@sym-browser/')) return undefined;
  if (ALLOWED_EXACT.has(specifier) || ALLOWED_PREFIXES.some((p) => specifier.startsWith(p))) return undefined;
  if (REPO_SCOPES.some((scope) => specifier.startsWith(scope))) return `paquet du dépôt hors frontière (${specifier})`;
  return undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Le module SYM Browser importe seulement @sym/contracts/browser et @runtime/ui hors de son dossier.' },
    messages: {
      forbidden: 'Import interdit par la frontière du module SYM Browser : {{reason}}. Permis hors du module : @sym/contracts/browser et @runtime/ui (ADR 23 § 2).',
    },
    schema: [],
  },
  create(context) {
    const file = context.physicalFilename;
    /** @param {{ source?: { type: string; value?: unknown } | null }} node */
    const check = (node) => {
      const source = node.source;
      if (!source || source.type !== 'Literal' || typeof source.value !== 'string') return;
      const reason = boundaryViolation(source.value, file);
      if (reason !== undefined) context.report({ node: source, messageId: 'forbidden', data: { reason } });
    };
    return {
      ImportDeclaration: check,
      ExportNamedDeclaration: check,
      ExportAllDeclaration: check,
      ImportExpression: check,
      /** @param {{ callee: { type: string; name?: string }; arguments: { type: string; value?: unknown }[] }} node */
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require' && node.arguments[0]) check({ source: node.arguments[0] });
      },
      /** `type T = import('x').T` : `source` (typescript-eslint 8.x récent), sinon l'ancien `argument`. */
      /** @param {{ source?: { type: string; value?: unknown }; argument?: { type: string; literal?: { type: string; value?: unknown } } }} node */
      TSImportType(node) {
        if (node.source) return check({ source: node.source });
        const argument = node.argument;
        if (argument) check({ source: argument.type === 'TSLiteralType' ? argument.literal : argument });
      },
    };
  },
};

/** Bloc de configuration ESLint (flat config) à ajouter à `runtime/eslint.config.mjs`. */
export const browserBoundaries = {
  files: ['modules/browser/**/*.{ts,mts,js,mjs,vue}'],
  plugins: { 'sym-browser': { rules: { boundaries: rule } } },
  rules: { 'sym-browser/boundaries': 'error' },
};
