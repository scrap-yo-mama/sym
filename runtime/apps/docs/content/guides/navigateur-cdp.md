---
title: "Brancher un navigateur CDP"
description: "Le navigateur d'un autre fournisseur derrière une adresse CDP : activation, capacités présentes et absentes, adaptateurs."
---

# Brancher un navigateur CDP

Par défaut, le worker pilote son propre Chromium, ou une session de SYM Browser quand `BROWSER_URL` désigne SYM Browser. Vous pouvez aussi lui donner le navigateur d'un autre fournisseur (Browserbase, Steel, Browserless, ou un Chromium que vous exposez vous-même en CDP). Ce fournisseur s'appelle `cdp`.

La console le dit ainsi : le navigateur vient d'un fournisseur CDP, et voici les capacités côté navigateur présentes et absentes.

Le choix d'un fournisseur tiers et son usage relèvent de vous : lisez la page [Usage responsable](../explications/usage-responsable.md).

## Activer le fournisseur

Un administrateur pose `BROWSER_ALLOW_GENERIC_CDP=true` sur le worker, avec l'une de ces deux formes :

- **URL fixe** : `BROWSER_URL` est l'adresse CDP (`ws://`, `wss://` ou `http://`), et `BROWSER_API_KEY` un jeton facultatif, envoyé en `Authorization: Bearer`. Un jeton déjà présent dans l'URL est masqué comme tout secret.
- **Adaptateur** : `BROWSER_CDP_ADAPTER` vaut `browserbase` ou `steel`, `BROWSER_URL` est l'adresse de l'API du fournisseur et `BROWSER_API_KEY` sa clé. Le worker crée une session par run, s'y connecte, puis la libère par l'API du fournisseur. `BROWSER_CDP_PROJECT_ID` précise le projet (Browserbase).

Sans `BROWSER_ALLOW_GENERIC_CDP=true`, le worker refuse de démarrer et le message nomme la variable. Les clés se donnent aussi par fichier (`BROWSER_API_KEY_FILE`, `BROWSER_CDP_PROJECT_ID_FILE`) ; elles ne figurent ni dans les journaux, ni dans les événements, ni dans les réponses de l'API.

La console affiche l'état du navigateur et ce tableau sous **Réglages > Navigateur**.

## Capacités côté navigateur

| Capacité côté navigateur | SYM Browser | Fournisseur CDP |
|---|---|---|
| Egress par session et garde SSRF au niveau réseau | présente | absente |
| Verrou de domaines sur les sauts de redirection et les sous-ressources, dans le réseau | présente | absente : le worker coupe les sauts par CDP |
| Budget d'octets par session (plafond `max_cost_usd`) | présente | absente |
| Arguments de lancement (prérendu, `WebSocketStream`) | présente | absente : le worker neutralise `WebSocketStream` par script d'initialisation |
| Proxy de lancement fermé (Chromium oisif muet) | présente | absente |
| Contexte neuf par run avec proxy imposé | présente | absente : une session fournisseur par run |
| Ordre « tuer avant détacher » | présente | absente |
| Bac à sable vérifié | présente | absente |
| User-Agent réel posé au lancement | présente | absente |
| Latence des gardes dans les seuils prévus | présente | absente |

## Ce que SYM garde à l'identique

Enquête, validation du schéma, réparation, lecture de robots.txt à chaque requête, classification des réponses, statuts, planification, MCP, gardes du worker par CDP (routes, WebSocket, contrôle de chaque requête, scripts d'initialisation, verrou et enregistreur de l'agent, comptage des écritures), requêtes de Node par l'egress local du worker (garde SSRF comprise) et masquage des secrets.

Un fournisseur qui débloque lui-même les sites masque à SYM les refus qu'il a déjà traités : les essais rendent alors moins de statuts « Bloquée ».

## Paramètres de session envoyés

La liste est fermée. SYM envoie la durée maximale de la session (`BROWSER_CDP_SESSION_TIMEOUT_SECONDS`, 900 par défaut), les identifiants de corrélation `runId` et `attemptId` en métadonnées quand le fournisseur en porte, et l'option « proxy du compte » quand l'administrateur pose `BROWSER_CDP_ACCOUNT_PROXY=true`. Tout autre réglage reste celui de votre compte chez le fournisseur ; une variable `BROWSER_CDP_*` inconnue est refusée par son nom.
