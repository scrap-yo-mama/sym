---
title: "Ligne de commande runtime"
description: "migrate, keygen, doctor, rekey, diagnostics, export-catalog, backup, restore-prepare."
---

# Ligne de commande `runtime`

La CLI est livrée dans l'image. Dans un conteneur : `node /app/apps/cli/dist/index.js <commande>`. Elle lit les mêmes variables d'environnement que `server` (`DATABASE_URL`, `MASTER_KEY`…). Aucune commande n'ouvre de connexion vers l'extérieur : elles ne parlent qu'à votre base.

| Commande | Rôle |
|---|---|
| `runtime --version` | affiche la version |
| `runtime migrate` | applique les migrations en attente ; idempotent, pris sous un verrou |
| `runtime migrate down [--steps N \| --all]` | descente de migrations, **pour les tests et la CI seulement** : refusée quand `NODE_ENV=production` |
| `runtime keygen` | affiche une `MASTER_KEY` neuve (32 octets en base64), sans l'écrire nulle part |
| `runtime key-check` | vérifie `MASTER_KEY` contre le témoin enregistré en base (le crée sur une base neuve) |
| `runtime rekey --confirm [--batch-size N]` | rotation de la clé : nouvelle clé dans `MASTER_KEY`, ancienne dans `MASTER_KEY_PREVIOUS` ; exige une sauvegarde préalable |
| `runtime doctor [--json]` | contrôles locaux ; code de sortie 0 (tout va bien), 1 (avertissement), 2 (erreur) |
| `runtime diagnostics [--out FICHIER]` | fichier masqué produit en local, jamais envoyé |
| `runtime export-catalog [--out FICHIER]` | API, schémas, stratégies et planifications en JSON, sans secret ni cookie |
| `runtime user:reset-link <email>` | lien de réinitialisation du mot de passe d'un compte, sans SMTP et sans 2FA ; audité, affiché une seule fois et signalé au titulaire à sa connexion suivante |
| `runtime owner:reset-link` | idem pour le compte owner |
| `runtime backup declare [--at DATE_ISO]` | note qu'une sauvegarde `pg_dump` vient d'être faite (rappel de `doctor`) |
| `runtime restore-prepare` | avant `pg_restore` sur une base vide : recrée le rôle `runtime_app` que le dump n'emporte pas |
| `runtime secrets accept-key-loss --confirm` | `MASTER_KEY` perdue : les secrets sont conservés « À ressaisir » et le témoin de clé est réécrit |

## Détails utiles

- **`migrate`** est la seule commande qui modifie le schéma. Deux exécutions simultanées appliquent chaque migration une seule fois. Il n'existe pas de migration descendante en production : voir [Mettre à jour et revenir en arrière](../guides/mise-a-jour.md).
- **`keygen`** ne stocke rien : copiez la valeur dans votre gestionnaire de mots de passe **avant** de la poser dans l'environnement.
- **`rekey`** réécrit chaque secret avec la nouvelle clé, par lots, et ne s'arrête qu'avec une base entièrement rechiffrée. Faites une sauvegarde d'abord.
- **`doctor`** et **`diagnostics`** : voir [Diagnostiquer une instance](../guides/diagnostic.md).
- **`export-catalog`** n'a pas d'option pour inclure les secrets : les secrets se ressaisissent sur l'instance de destination.
- **`secrets accept-key-loss`** sans `--confirm` montre ce qui serait fait et ne modifie rien. Voir [Sauvegarder et restaurer](../guides/sauvegarde.md#si-vous-perdez-master-key).
