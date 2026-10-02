---
name: escalade-par-defaut
description: Politique par défaut « du moins cher au plus cher » (04 §3.3) ; ordre, élagages et arrêts exécutés par le code.
kind: rule
applies_to: ["*"]
---
# Escalade par défaut : du moins cher au plus cher

Transcription de 04 §3.3, sans heuristique ajoutée. Le code calcule l'ensemble des couples (E, N) autorisés et leur
coût estimé ; il exécute lui-même l'ordre, les élagages et les arrêts ci-dessous, quoi que dise ce fichier. Ce texte les
décrit pour que l'agent les connaisse.

## Ordre d'essai

Couples autorisés triés par `est_cost_usd` croissant, puis par E (E1 à E6), puis par N (N1 à N3).

## Élagage après un échec (classe du classifieur)

- `network` : sauter les couples restants avec le même N.
- `extraction` : sauter les couples restants avec le même E.

## Arrêts

- `blocked_by_protection`, `forbidden`, `robots_disallowed` : arrêt de tout essai, statut `bloquee`.
- `auth_required`, `payment_required` : la main revient à l'utilisateur, statut `action_requise`.

## Sélection

La stratégie retenue est la moins chère conforme parmi les couples essayés. Un couple moins cher, ni essayé ni exclu par
une règle, est essayé avant de retenir.
