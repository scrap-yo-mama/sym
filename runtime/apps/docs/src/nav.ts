// SPDX-License-Identifier: AGPL-3.0-only
// Registre unique des pages du site (16 § 4) : quadrants Diátaxis, ordre, titre et résumé. La configuration VitePress
// (barre latérale), llms.txt et les tests de contenu en dérivent : une page absente d'ici n'existe pas pour le site.

export type Quadrant = 'tutoriels' | 'guides' | 'reference' | 'explications';

export type PageEntry = {
  /** Chemin relatif à `content/`, sans extension. */
  path: string;
  title: string;
  /** Une phrase : sert de résumé dans llms.txt et dans la page d'accueil. */
  summary: string;
  quadrant: Quadrant;
  /** Page produite à la construction (OpenAPI, console) : absente du dépôt. */
  generated?: true;
};

export const QUADRANTS: readonly { id: Quadrant; title: string; summary: string }[] = [
  { id: 'tutoriels', title: 'Tutoriels', summary: 'Apprendre en faisant : de l’installation à la première API.' },
  { id: 'guides', title: 'Guides pratiques', summary: 'Accomplir une tâche précise : déployer, brancher, sauvegarder, mettre à jour.' },
  { id: 'reference', title: 'Référence', summary: 'Consulter un fait exact : REST, MCP, variables, statuts, versions.' },
  { id: 'explications', title: 'Explications', summary: 'Comprendre le produit, ses choix et ses limites.' },
];

export const PAGES: readonly PageEntry[] = [
  { path: 'tutoriels/quickstart', quadrant: 'tutoriels', title: 'Démarrage rapide', summary: 'Installer une instance, créer son compte propriétaire, obtenir une clé d’API et connecter son IA.' },

  { path: 'guides/deploiement', quadrant: 'guides', title: 'Déployer une instance', summary: 'Choisir l’hébergement, préparer les variables et la clé maîtresse, vérifier que l’instance répond.' },
  { path: 'guides/render', quadrant: 'guides', title: 'Déployer sur Render', summary: 'Cible de référence : deux services sur la même image, une base PostgreSQL, la migration avant chaque déploiement.' },
  { path: 'guides/docker-compose', quadrant: 'guides', title: 'Déployer avec Docker Compose', summary: 'Un VPS ou Coolify : PostgreSQL, migration, serveur et worker, TLS par un proxy inverse.' },
  { path: 'guides/autres-hebergeurs', quadrant: 'guides', title: 'Railway, Heroku et autres hébergeurs', summary: 'Best-effort : ce qui est attendu de n’importe quel hébergeur de conteneurs et ses pièges connus.' },
  { path: 'guides/modele-llm', quadrant: 'guides', title: 'Brancher son modèle IA', summary: 'Un fournisseur compatible OpenAI choisi par vous, ses clés chiffrées, ses capacités sondées.' },
  { path: 'guides/proxys', quadrant: 'guides', title: 'Configurer des proxys', summary: 'Proxys serveur et résidentiels définis par l’administrateur, et ce qu’ils ne font jamais.' },
  { path: 'guides/extension-et-tunnel', quadrant: 'guides', title: 'Extension Chrome et tunnel', summary: 'Appairer l’extension, connecter un site avec votre propre session, exécuter depuis votre navigateur.' },
  { path: 'guides/sauvegarde', quadrant: 'guides', title: 'Sauvegarder et restaurer', summary: 'Deux objets à garder : la base et la clé maîtresse ; restauration sur une base neuve.' },
  { path: 'guides/mise-a-jour', quadrant: 'guides', title: 'Mettre à jour et revenir en arrière', summary: 'De la version N-1 à N, et le seul retour arrière qui tienne : image précédente et restauration.' },
  { path: 'guides/diagnostic', quadrant: 'guides', title: 'Diagnostiquer une instance', summary: 'doctor, diagnostics masqué, sondes de santé et métriques fermées par défaut.' },
  { path: 'guides/comptes', quadrant: 'guides', title: 'Comptes, rôles et clés d’API', summary: 'Premier démarrage, rôles owner, admin et member, clés d’API à portées, isolement entre utilisateurs.' },

  { path: 'reference/rest', quadrant: 'reference', title: 'API REST', summary: 'Chaque route de l’OpenAPI, son authentification et son état de livraison (générée à la construction).', generated: true },
  { path: 'reference/mcp', quadrant: 'reference', title: 'Serveur MCP', summary: 'Outils génériques, outils par API, enveloppe de résultat, modes d’exposition et erreurs.' },
  { path: 'reference/variables-environnement', quadrant: 'reference', title: 'Variables d’environnement', summary: 'Toutes les variables lues par le serveur, le worker et la CLI, avec leurs défauts.' },
  { path: 'reference/statuts-et-raisons', quadrant: 'reference', title: 'Statuts et classes d’échec', summary: 'Les sept statuts d’une API, les 21 transitions, le drapeau stale et les classes d’échec.' },
  { path: 'reference/codes-de-raison', quadrant: 'reference', title: 'Codes de raison', summary: 'Chaque code stable, son libellé et son texte, tels que la console les affiche (généré).', generated: true },
  { path: 'reference/cli', quadrant: 'reference', title: 'Ligne de commande runtime', summary: 'migrate, keygen, doctor, rekey, diagnostics, export-catalog, backup, restore-prepare.' },
  { path: 'reference/compatibilite', quadrant: 'reference', title: 'Compatibilité des versions', summary: 'GET /api/version, versions d’extension acceptées, PostgreSQL, Node et politique de support.' },

  { path: 'explications/usage-responsable', quadrant: 'explications', title: 'Usage responsable', summary: 'Votre responsabilité, le RGPD, les conditions des sites, la conservation et les usages déconseillés.' },
  { path: 'explications/hors-perimetre', quadrant: 'explications', title: 'Hors périmètre', summary: 'Les six fonctions que le produit ne fournira jamais, et pourquoi.' },
  { path: 'explications/securite', quadrant: 'explications', title: 'Sécurité', summary: 'Secrets chiffrés, bac à sable, garde SSRF, isolement des utilisateurs et ce que le produit ne protège pas.' },
  { path: 'explications/telemetrie', quadrant: 'explications', title: 'Télémétrie', summary: 'Aucune donnée ne part vers l’éditeur : ce que cela couvre, ce qui reste local.' },
  { path: 'explications/architecture', quadrant: 'explications', title: 'Architecture', summary: 'Serveur, worker, PostgreSQL, échelle des stratégies, enquête et machine à états.' },
  { path: 'explications/robot', quadrant: 'explications', title: 'Le robot Scrapyomama', summary: 'Jeton produit, User-Agent, comment le bloquer, qui contacter : à l’usage des webmasters.' },
];
