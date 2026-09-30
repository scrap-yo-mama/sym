Dockerfile, entrypoint et modèles de déploiement (tâches 0.1, 4.x).

`TRUST_PROXY` (serveur) : défaut `false`, l'IP d'un client est celle de la connexion TCP. Derrière le proxy d'un hébergeur (Render, Railway, Heroku), poser `TRUST_PROXY=1` (un saut) ou la liste des IP/CIDR du proxy : sinon toutes les requêtes semblent venir du proxy et partagent les limites par IP. Ne jamais poser `true` sans proxy devant : un client choisirait son IP par `X-Forwarded-For`.
