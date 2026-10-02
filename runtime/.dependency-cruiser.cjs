// SPDX-License-Identifier: AGPL-3.0-only
// Frontières entre modules (tâche 5.0, docs/modules.md), en rapport seulement : toutes les règles sont en `warn`, le job
// nightly ne bloque jamais (`pnpm deps:report`). Un paquet de l'espace de travail se désigne soit par son nom (`@runtime/db`,
// quand `dist/` n'est pas construit), soit par son dossier (`packages/db/`, une fois résolu) : `pkg()` couvre les deux.

/** Motif de chemin d'un paquet ou d'une application de l'espace de travail, résolu ou non. */
const pkg = (name) => `(^|/)(packages|apps)/${name}/|(^|/)@runtime/${name}(/|$)`;
const any = (...names) => names.map(pkg).join('|');
/** Tests et bancs de bout en bout : ils montent un serveur et une base réels, hors du code livré. */
const NOT_SHIPPED = '\\.(unit|prop|integration|contract|security|image|e2e)\\.test\\.ts$|/e2e/|/testing/|/tests/';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'front-pas-serveur',
      comment: 'Front (console, docs, UI) : parle au serveur par @runtime/client, jamais en important le serveur, le worker, la base, le CLI ni le Brain.',
      severity: 'warn',
      from: { path: '(^|/)apps/(web|docs)/|(^|/)packages/(ui|client)/', pathNot: NOT_SHIPPED },
      to: { path: any('server', 'worker', 'db', 'agent', 'llm', 'cli') },
    },
    {
      name: 'extension-pas-worker',
      comment: 'Extension : ne parle au serveur que par le contrat de tunnel (@runtime/core/tunnel) ; ni worker, ni serveur, ni base, ni Brain.',
      severity: 'warn',
      from: { path: '(^|/)apps/extension/', pathNot: NOT_SHIPPED },
      to: { path: any('server', 'worker', 'db', 'agent', 'llm', 'cli') },
    },
    {
      name: 'brain-pas-runner',
      comment: 'Brain (agent, llm) : ni application (serveur, worker, CLI, console, extension) ni base de données ; il ne dépend que du noyau.',
      severity: 'warn',
      from: { path: '(^|/)packages/(agent|llm)/', pathNot: NOT_SHIPPED },
      to: { path: any('server', 'worker', 'cli', 'web', 'docs', 'extension', 'db') },
    },
    {
      name: 'core-sans-dependance-interne',
      comment: "Noyau (core) : sans I/O applicatif, il n'importe aucun autre paquet ni aucune application de l'espace de travail.",
      severity: 'warn',
      from: { path: '(^|/)packages/core/', pathNot: NOT_SHIPPED },
      to: { path: any('db', 'agent', 'llm', 'client', 'ui', 'schemas', 'server', 'worker', 'cli', 'web', 'docs', 'extension') },
    },
    {
      name: 'paquets-sans-application',
      comment: "Un paquet (packages/*) n'importe jamais une application (apps/*).",
      severity: 'warn',
      from: { path: '(^|/)packages/', pathNot: NOT_SHIPPED },
      to: { path: any('server', 'worker', 'cli', 'web', 'docs', 'extension') },
    },
    {
      name: 'apps-sans-apps',
      comment: "Les applications ne s'importent pas entre elles : elles partagent des paquets, jamais du code d'application.",
      severity: 'warn',
      from: { path: '(^|/)apps/([^/]+)/', pathNot: NOT_SHIPPED },
      to: { path: '(^|/)apps/', pathNot: '(^|/)apps/$2/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|\\.wxt|\\.output|coverage|node_modules|generated)/' },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
  },
};
