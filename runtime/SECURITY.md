# Politique de sécurité

> Brouillon, à valider par un avocat avant toute publication (en particulier la section « Règles pour les chercheurs » et le délai de publication coordonnée). Les délais ci-dessous sont des engagements visés, pas une garantie contractuelle.

## Signaler une vulnérabilité

**Jamais par une issue ou une discussion publique.** Un seul canal, privé : le **signalement privé de vulnérabilité de GitHub** ([ouvrir un signalement](https://github.com/scrap-yo-mama/sym/security/advisories/new), ou onglet « Security », « Report a vulnerability »). Il ouvre un avis de sécurité (GHSA) visible de vous et des mainteneurs seulement.

Merci de joindre : la version concernée, les étapes de reproduction, l'impact estimé, et toute preuve utile (journaux masqués : pas de secret, de cookie ni d'URL cible réelle).

## Délais

| Étape | Délai visé |
|---|---|
| Accusé de réception | **72 heures** |
| Première évaluation (recevable ou non, gravité estimée) | à définir avec l'accusé de réception |
| Correctif | visé sous 90 jours au plus (à valider) |
| Publication coordonnée de l'avis | le jour de l'image corrigée, au plus tard 90 jours après le signalement (à valider), avec demande de CVE via GitHub |

Le crédit dans l'avis est accordé si vous le souhaitez.

## Versions supportées

Avant la 1.0 : la branche courante et la version MINOR précédente (à valider avec la politique de support).

## Périmètre

| Dans le périmètre | Hors périmètre |
|---|---|
| Le service (API REST, MCP, console), le worker, l'extension, les images de conteneur publiées | Les sites scrapés, leurs protections et leur contournement ([Hors périmètre](docs/hors-perimetre.md)) |
| L'isolation du code généré, la garde SSRF, le chiffrement des secrets, l'authentification et les clés à scopes | Les instances mal configurées par leur administrateur (secrets exposés, ports ouverts) |
| Les dépendances, quand la faille atteint le produit | Les failles sans effet démontré sur le produit, les rapports d'un scanner sans analyse |

Un rapport qui demande de franchir une protection d'un site n'est pas un rapport de sécurité : il est hors périmètre.

## Ce que le produit garantit, honnêtement

Le bac à sable du code généré est une **défense en profondeur**, pas une frontière absolue : il réduit l'impact d'un défaut, il ne l'exclut pas. D'autres couches (garde SSRF sur chaque connexion, secrets chiffrés, sorties validées) agissent en complément.

## Règles pour les chercheurs (brouillon, à valider par un avocat)

- Testez sur **votre propre instance**, jamais sur celle d'un tiers ni sur un site réel.
- Ne lisez, ne modifiez et ne conservez aucune donnée qui n'est pas la vôtre ; arrêtez dès qu'une donnée d'autrui devient accessible et signalez-le.
- Pas de déni de service, pas d'ingénierie sociale, pas d'atteinte à des tiers.
- Laissez-nous le temps de corriger avant toute divulgation.

Une recherche menée de bonne foi dans ces règles ne donnera pas lieu à des poursuites de la part des mainteneurs. Cette déclaration d'intention (*safe harbor*) n'engage pas les tiers ; sa rédaction juridique reste à valider.

## Avis et veille

Les avis passent par GitHub Security Advisories. Les mises à jour de dépendances sont suivies automatiquement ; `pnpm audit` bloque la CI sur une faille « critical ».
