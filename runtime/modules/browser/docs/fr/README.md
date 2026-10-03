# SYM Browser

SYM 👻 : Salut ! Je te prête des navigateurs à la demande. Tu demandes une session, je démarre un Chromium pour toi, tu le pilotes avec le client CDP de ton choix, et quand tu as fini, j'efface tout.

SYM Browser est un service de navigateurs auto-hébergé. Une image, trois rôles (`all`, `gateway`, `node`), une base PostgreSQL et une clé maîtresse. Chaque session reçoit son Chromium à elle (type `dedicated`, par défaut) ou un contexte neuf dans un Chromium chaud (type `shared`), son propre réseau sortant avec une liste d'hôtes autorisés et un budget d'octets, et elle est entièrement détruite à la fin.

## Pour commencer

1. [Démarrage rapide](quickstart.md) : démarre une instance, ouvre une session, pilote-la avec Playwright, libère-la. Une dizaine de minutes.
2. [Branche ton client](clients/README.md) : Playwright, Puppeteer, Stagehand, browser-use, Skyvern, Playwright MCP, Chrome DevTools MCP.
3. [SDK TypeScript](sdk.md) : sessions, connexions et événements en quelques lignes.

## Faire tourner SYM Browser

- [Déploiement](deployment.md) : l'image, `SYMB_MODE=all`, PostgreSQL, la clé maîtresse, la santé.
- [Nœuds](nodes.md) : une passerelle devant plusieurs nœuds, capacité, drainage.
- [Topologies](topologies.md) : à côté de SYM, ou isolé sur son propre serveur.

## Référence

- [API](reference/api.md) : opérations, scopes, statuts, codes d'erreur, connexions WebSocket. Générée depuis le document OpenAPI du contrat.
- [Configuration](reference/configuration.md) : chaque variable d'environnement. Générée depuis le catalogue de configuration.

## Ce sur quoi tu peux compter

| Promesse | Ce que ça veut dire pour toi |
|---|---|
| Isolation | Deux sessions ne partagent jamais cookies, stockage, cache, onglets, téléchargements ni identifiants de proxy. |
| Réseau gouverné | Chaque connexion d'une session passe par son egress : hôtes autorisés, ports, budget d'octets. |
| Destruction complète | À la fin d'une session, ses processus, son répertoire de profil et ses fichiers disparaissent ; seul reste ce que tu as demandé de garder. |
| Secrets protégés | Jetons, mots de passe de proxy et profils persistants sont chiffrés au repos et jamais écrits dans les journaux. |
| Accès authentifié | Chaque appel REST et chaque WebSocket est vérifié avant d'atteindre un navigateur. |
| Compatibilité CDP | Une session `dedicated` se pilote avec sa seule `connectUrls.cdp`. |
