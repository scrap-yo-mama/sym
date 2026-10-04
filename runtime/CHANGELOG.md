# Changelog

## 1.0.0 (2026-10-04)

Première version publique de SYM, runtime open source et auto-hébergé de création d'API par agent.

### Ce que la 1.0 livre

- **Création d'API en langage naturel** : vous décrivez les données voulues, depuis un client MCP ou depuis la console web ; SYM en fait une API typée.
- **Enquête** : un agent explore le site cible (navigateur, requêtes, structure des pages), avec budget et plafond d'essai bornés.
- **Schéma** : le schéma de sortie est proposé, typé et versionné ; il se valide et se corrige depuis la console.
- **Stratégies et rejeu sans LLM** : l'API retenue est rejouée sans appeler de modèle, y compris la stratégie html compilée (sélecteurs et champs écrits une fois, rejoués à coût nul).
- **Réparation** : quand un site change, SYM détecte la dérive, rejoue l'enquête et propose un correctif.
- **Planification** : exécutions récurrentes, budget USD quotidien appliqué aux planifications.
- **Export et import** : une API se sauvegarde et se transporte d'une instance à l'autre.
- **Multi-utilisateur** : rôles, 2FA, OIDC, clés d'API à scopes, journal d'audit.
- **Protection SSRF et bac à sable** : garde des requêtes sortantes et de l'agent, exécution du code généré dans un bac à sable isolé.
- **Extension navigateur et tunnel** : l'extension Chrome relie vos sessions locales à l'instance.
- **Console en anglais et en français.**
- **Déploiement** : Render (Blueprint), Railway, Docker Compose (VPS, Coolify, Dokploy).

### Prévu en 1.1

- Boucle d'apprentissage (signaux objectifs tirés des runs) et schéma assisté (taux de présence, restructuration par l'IA).
- Itération par MCP (brouillons d'API) et exposition des règles par REST, MCP, console, import et export.
- Écran Démarrage guidé, panneau latéral de l'extension et voix SYM complète en français et en anglais.
- Démo sans clé, landing fidèle à la maquette, régression visuelle par langue.
- Exploration exhaustive de l'application par agent, avec mesures d'ergonomie.
