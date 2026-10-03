# Topologies

SYM 👻 : Même image, même protocole, deux façons de vivre : juste à côté de SYM, ou chez toi tout seul. Seule la configuration change.

| Topologie | Où | Réseau et secrets | Base |
|---|---|---|---|
| Avec SYM (non isolée) | Même hôte ou projet que SYM, dans un conteneur séparé | Réseau privé, aucun port publié ; sa propre `MASTER_KEY` ; une clé d'échange générée, partagée avec SYM | Sa propre base logique et son propre rôle, sur le serveur PostgreSQL de SYM si ça fait économiser |
| Isolée | Son propre serveur ou hébergeur | URL TLS publique et clés d'API | Son propre PostgreSQL |
| Développement | Même conteneur, process séparé | Boucle locale | Base de développement |

## Avec SYM

SYM Browser tourne dans un conteneur séparé à côté de SYM, comme un exécuteur de tâches externe. SYM le pilote comme n'importe quel client : une clé d'API, l'API `/v1`, les `connectUrls`.

1. Génère une clé d'échange. SYM la lit dans `BROWSER_API_KEY`, SYM Browser dans `SYMB_BOOTSTRAP_API_KEY` (il crée la clé, client `sym`, au premier démarrage).
2. Donne à chaque service sa propre clé maîtresse : ne partage jamais `MASTER_KEY` entre SYM et SYM Browser.
3. Fais pointer le worker de SYM vers SYM Browser avec `BROWSER_URL`, sur le réseau privé.

```yaml
# docker compose (extrait)
services:
  sym-browser:
    image: ghcr.io/scrap-yo-mama/sym-browser:1
    profiles: [browser]
    security_opt: ['seccomp=deploy/seccomp-chromium.json', 'no-new-privileges']
    cap_drop: [ALL]
    environment:
      SYMB_MODE: all
      DATABASE_URL: postgres://sym_browser:${SYMB_DB_PASSWORD}@postgres:5432/sym_browser
      MASTER_KEY: ${SYMB_MASTER_KEY}
      SYMB_BOOTSTRAP_API_KEY: ${SYMB_EXCHANGE_KEY}
  worker:
    environment:
      BROWSER_URL: http://sym-browser:3000
      BROWSER_API_KEY: ${SYMB_EXCHANGE_KEY}
```

- Aucun port n'est publié : seul le worker atteint `sym-browser:3000`.
- Au démarrage, le worker appelle `GET /v1/version` : `product: "sym-browser"` et la même version majeure.mineure de Playwright sélectionnent le fournisseur `sym-browser`. Le worker démarre même si SYM Browser n'est pas encore prêt, et réessaie.
- La base et le rôle `sym_browser` vivent sur le serveur PostgreSQL de SYM, séparés de la base de SYM.

Sur Railway, `BROWSER_URL` utilise le domaine privé du service `sym-browser` ; sur Render, le bouton « SYM + SYM Browser » fait tourner SYM Browser en mode `all` dans un service privé.

## Isolée

SYM Browser vit sur son propre serveur et sert n'importe quel projet : le tien, un SYM sur un autre hôte, ou des outils tiers.

- Une URL TLS publique (`https://browser.example.com`) devant la passerelle : les `connectUrls` sont alors en `wss://`.
- Son propre PostgreSQL (`DATABASE_URL`) et sa propre `MASTER_KEY`.
- Des clés d'API par client, créées dans la console, avec scopes et quotas.
- Sur Render, le bouton « SYM Browser seul » déploie une passerelle web, un nœud privé et PostgreSQL ; ajoute des nœuds comme décrit dans [nœuds](nodes.md).

Un SYM ailleurs se connecte avec `BROWSER_URL=https://browser.example.com` et une clé d'API dans `BROWSER_API_KEY` (scopes `sessions:write` et `sessions:read`).

## Développement

Fais tourner la passerelle et le nœud dans un seul process sur ta machine (`SYMB_MODE=all`, `PORT=3000`) avec un PostgreSQL local, comme dans le [démarrage rapide](quickstart.md).

## Laquelle choisir ?

| Tu veux | Choisis |
|---|---|
| Des navigateurs pour SYM sur la même machine, rien d'exposé | Avec SYM |
| Un service de navigateurs pour plusieurs projets ou équipes | Isolée |
| Plus de navigateurs qu'une machine n'en tient | Isolée, puis ajoute des [nœuds](nodes.md) |
