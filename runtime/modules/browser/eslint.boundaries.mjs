// SPDX-License-Identifier: AGPL-3.0-only
// Frontière du module SYM Browser (ADR 23 § 2 et § 3 ; cdc/sym-browser 03 § 9), en lint bloquant : un fichier du module
// n'importe, hors du module, que `@sym/contracts/browser` et `@runtime/ui` (packages/ui). Refusés : tout autre paquet du
// dépôt (`@runtime/*`, `@sym/*`), tout autre sous-chemin de `@sym/contracts`, et tout chemin relatif ou absolu qui sort de
// `modules/browser/` (contournement par chemin), cible réelle comprise : un lien symbolique (lien `node_modules` de pnpm
// notamment) est suivi, et tout chemin qui traverse un dossier `node_modules` est refusé. Formes contrôlées : import et
// export statiques, `import()`, `import('x').T` en type, `require`, `require.resolve`, `module.require`, et la fonction
// renvoyée par `createRequire` (ou `module.createRequire`) avec sa méthode `resolve`, spécificateur littéral ou gabarit
// sans expression. Les paquets npm tiers et les modules intégrés de Node restent permis.
// Règle locale, sans dépendance : elle voyage avec le module (miroir public, tâche 5.8).
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
const MODULE_REAL = realpathSync(MODULE_ROOT);

/** Chemin réel : le plus long ancêtre existant passe par fs.realpathSync (liens symboliques suivis), le reste est recollé. */
function realTarget(target) {
  let existing = target;
  const rest = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return target;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync(existing), ...rest);
}

/** `target` hors de `root` ? */
const outside = (root, target) => {
  const rel = relative(root, target);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

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
    if (outside(MODULE_ROOT, target)) return `chemin hors de modules/browser/ (${specifier})`;
    if (specifier.split(/[\\/]/).includes('node_modules')) return `chemin par node_modules (${specifier})`;
    return outside(MODULE_REAL, realTarget(target)) ? `lien symbolique hors de modules/browser/ (${specifier})` : undefined;
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
    /** Valeur d'un spécificateur littéral ou d'un gabarit sans expression, sinon `undefined`. */
    const specifierOf = (node) => {
      if (!node) return undefined;
      if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked ?? undefined;
      return undefined;
    };
    const check = (source) => {
      const value = specifierOf(source);
      if (value === undefined) return;
      const reason = boundaryViolation(value, file);
      if (reason !== undefined) context.report({ node: source, messageId: 'forbidden', data: { reason } });
    };
    /** Appel à `createRequire(…)` ou `<x>.createRequire(…)`. */
    const isCreateRequire = (node) =>
      node?.type === 'CallExpression' &&
      ((node.callee.type === 'Identifier' && node.callee.name === 'createRequire') ||
        (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.name === 'createRequire'));
    /** Noms liés à une fonction require : `require` et toute variable initialisée par createRequire. */
    const requireNames = new Set(['require']);
    /** Appels candidats, vérifiés en fin de fichier (une variable peut servir avant sa déclaration dans le texte). */
    const calls = [];
    /** La fonction appelée est-elle un require ? `require`, `r` (createRequire), `createRequire(…)`, `module.require`, `<require>.resolve`. */
    const isRequireCallee = (callee) => {
      if (callee.type === 'Identifier') return requireNames.has(callee.name);
      if (isCreateRequire(callee)) return true;
      if (callee.type !== 'MemberExpression' || callee.computed) return false;
      const object = callee.object;
      const property = callee.property.name;
      if (property === 'require' && object.type === 'Identifier' && object.name === 'module') return true;
      if (property === 'resolve') return isRequireCallee(object);
      return false;
    };
    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      VariableDeclarator(node) {
        if (node.id.type === 'Identifier' && isCreateRequire(node.init)) requireNames.add(node.id.name);
      },
      AssignmentExpression(node) {
        if (node.left.type === 'Identifier' && isCreateRequire(node.right)) requireNames.add(node.left.name);
      },
      CallExpression(node) {
        if (node.arguments[0]) calls.push(node);
      },
      'Program:exit'() {
        for (const node of calls) if (isRequireCallee(node.callee)) check(node.arguments[0]);
      },
      /** `type T = import('x').T` : `source` (typescript-eslint 8.x récent), sinon l'ancien `argument`. */
      TSImportType(node) {
        if (node.source) return check(node.source);
        const argument = node.argument;
        if (argument) check(argument.type === 'TSLiteralType' ? argument.literal : argument);
      },
      /** `import x = require('y')` (TypeScript, fichiers .cts). */
      TSExternalModuleReference: (node) => check(node.expression),
    };
  },
};

/** Blocs de configuration ESLint (flat config) à ajouter à `runtime/eslint.config.mjs` : lecture du JSX, puis la règle. */
export const browserBoundaries = [
  { files: ['modules/browser/**/*.jsx'], languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
  {
    files: ['modules/browser/**/*.{ts,mts,cts,tsx,js,mjs,cjs,jsx,vue}'],
    plugins: { 'sym-browser': { rules: { boundaries: rule } } },
    rules: { 'sym-browser/boundaries': 'error' },
  },
];
