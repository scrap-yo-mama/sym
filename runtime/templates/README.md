# Modèles d'API (`templates/`)

Exports d'API d'exemple au format portable `scrapyomama.api` 1.0 (tâche 3.12, CDC 16 § 6), pour démarrer une instance
neuve sans galerie hébergée. Chaque fichier s'importe tel quel :

```sh
# Aperçu (rien n'est écrit), puis confirmation : l'API repasse par l'enquête (rapport d'accès, robots.txt, puis essais).
curl -sS -H "Authorization: Bearer $SYM_API_KEY" -H 'content-type: application/json' \
  --data @templates/livres-demo.api.json "$PUBLIC_URL/api/apis/import"
curl -sS -H "Authorization: Bearer $SYM_API_KEY" -H 'content-type: application/json' \
  --data @templates/livres-demo.api.json "$PUBLIC_URL/api/apis/import?confirm=true"
```

| Fichier | Site visé | Stratégie |
|---|---|---|
| `citations-demo.api.json` | site de démonstration de citations (fait pour s'exercer) | E1 `fetch`, API JSON paginée |
| `livres-demo.api.json` | catalogue de démonstration de livres (fait pour s'exercer) | E1 `fetch`, page HTML (sélecteurs CSS) |

## Règles (vérifiées par la CI : `tests/templates.unit.test.ts`)

- Modèles **déclaratifs** seulement (E1 à E3, réseau `direct`) : aucun code, aucun agent. Jamais le tunnel : un `tunnel`
  dans `network_policy.allow` est écarté à l'import (listé dans `ignored_fields`).
- Le format n'a **aucun champ** pour une session, un cookie, une clé, un identifiant de proxy, un secret ou un réglage de
  contournement ; un champ inconnu est ignoré à l'import.
- `fixtures.items` : enregistrements **synthétiques** (préfixe `Zz`), conformes au schéma de sortie ; aucune donnée réelle,
  aucune donnée personnelle.
- **Réponse enregistrée** : chaque modèle a une réponse synthétique dans `responses/<modèle>.response.<ext>` (JSON ou HTML,
  préfixe `Zz`). La CI y rejoue la stratégie déclarative hors ligne : la sortie doit égaler `fixtures.items`, champ par champ.
- Planifications désactivées, aucune cible d'alerte : le propriétaire les choisit après l'import.
- Fichier **scellé** (`integrity.sha256`, empreinte du JSON canonique sans `integrity`) et écrit à **clés triées** : un
  modèle modifié à la main doit être rescellé (`sealExport` puis `formatExport` de `@runtime/core`), sinon l'import le
  refuse (`integrity_mismatch`) et la CI échoue.
- Un import ne lance aucune requête par lui-même : l'enquête qui suit respecte robots.txt, la cadence par domaine et le
  rapport d'accès, comme toute API.
