---
title: "Configurer des proxys"
description: "Proxys serveur et résidentiels définis par l'administrateur, et ce qu'ils ne font jamais."
---

# Configurer des proxys

Par défaut, une instance sort sur Internet avec **l'adresse de son hébergeur** (mode réseau `direct`, N1). Les proxys sont facultatifs et **entièrement à vous** : vous les louez, vous les configurez, vous en répondez. Le produit n'en fournit aucun.

## Ce que fait un proxy ici, et ce qu'il ne fait pas

Un proxy sert à des motifs **réseau** : un contenu propre à un pays, ou une erreur de connexion depuis l'adresse de l'hébergeur. Il ne sert **jamais** à échapper à un refus.

- Un **401 ou un 403** n'entraîne jamais de changement d'adresse : l'exécution s'arrête et l'API passe en « Bloquée » ou « Action requise ».
- Un **429** entraîne un ralentissement, sur la même adresse.
- Un **défi de vérification** arrête toute escalade.

Ce n'est pas un réglage : c'est la ligne du produit (voir [Hors périmètre](../explications/hors-perimetre.md)). Le classifieur n'autorise la montée d'un cran réseau que pour la géo-restriction ou une erreur de connexion.

## Les trois niveaux

| Niveau | Mode | Qui le décide |
|---|---|---|
| N1 | `direct` : l'adresse de l'hébergeur | par défaut |
| N2 | `dc_proxy` : un proxy serveur (datacenter) | défini par l'administrateur, utilisable par une API s'il est configuré |
| N3 | `res_proxy` : un proxy résidentiel | défini par l'administrateur, **opt-in API par API** |

Le tunnel (l'exécution depuis **votre** navigateur, avec votre adresse) est un mode distinct qu'on choisit pour une API : voir [Extension Chrome et tunnel](./extension-et-tunnel.md).

## Qui configure quoi

- **Seul un administrateur** déclare un proxy : type (`dc` serveur ou `res` résidentiel), URL `http(s)://` ou `socks5://`, identifiants chiffrés, paramètres du fournisseur (pays, ville, session) et prix par gigaoctet ou par requête.
- Une API ne peut que **choisir** un proxy existant, par son identifiant. Une stratégie, un prompt ou un membre ne fournit jamais d'URL de proxy.
- Le résidentiel (N3) est réservé aux motifs réseau et s'active **explicitement par API**, jamais par défaut ni par rôle : il coûte cher et engage votre responsabilité auprès du fournisseur (vérification d'identité, cas d'usage déclaré).
- Chaque run enregistre le mode réseau utilisé et le coût du proxy. Le mode est visible sur la fiche de l'API.

## Garde SSRF

Quel que soit le mode, la sortie réseau est filtrée : l'adresse réellement résolue est contrôlée à chaque connexion (adresses privées et réservées, métadonnées d'un cloud, redirections, résolution qui change entre deux contrôles). Si vous avez besoin d'atteindre un hôte privé (un site interne à tester, un Ollama local), l'administrateur l'autorise explicitement par `ALLOWED_PRIVATE_HOSTS` (noms exacts ou plages CIDR, jamais plus large que `/8` en IPv4 ni `/16` en IPv6). Voir la [référence des variables](../reference/variables-environnement.md).

Limite connue : quand un proxy amont résout lui-même le nom d'hôte, la garde locale ne voit pas l'adresse finale. Choisissez des fournisseurs de confiance.

::: info Disponibilité
Le réglage des proxys se fait sous **Réglages > Proxys** dans la console ; la route REST correspondante (`/api/settings/proxies`) est « en préparation » dans cette version. La couche réseau et la garde SSRF sont livrées.
:::
