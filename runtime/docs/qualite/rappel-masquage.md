# Rappel du masquage des couches 1 et 2

Tâche 2.12 (19 §3, r4 R12, R14, R17). Avant tout envoi à un LLM (`investigate`, `repair`, `judge`, `reflect`, agent d'étape,
mémoire du catalogue), le code masque **toujours**, que `llm.redact` soit actif ou non :

1. par schéma : chaque valeur d'un champ `x-personal` devient un placeholder indexé (`[personal_1]`, …) ;
2. par motifs écrits en TypeScript (`packages/core/src/privacy/llm-mask.ts`) : e-mail, téléphone français et E.164, IBAN
   (clé mod 97), carte (clé de Luhn), IPv4 et IPv6, URL de profil, NIR.

La NER locale (couche 3) est prévue en V1.1. Ce masquage réduit l'exposition ; il **n'anonymise pas** les données.

## Rappel mesuré sur le corpus de fixtures françaises

Corpus : `packages/core/src/privacy/fr-pii-corpus.testkit.ts` (valeurs fictives). Une valeur est comptée masquée quand elle
n'apparaît plus dans le texte masqué. Table publiée telle que mesurée par `assert_llm_redaction_fr_corpus` (le test échoue
si elle diffère de la mesure).

| Type | Rappel |
|---|---|
| `email` | 6/6 |
| `phone` | 8/8 |
| `iban` | 3/4 |
| `card` | 2/3 |
| `ip` | 3/3 |
| `profile_url` | 5/5 |
| `nir` | 3/3 |

Écarts connus : un IBAN ou un numéro de carte dont la clé de contrôle est fausse n'est pas masqué (choix contre les faux
positifs sur les références et les montants) ; un nom de personne dans un texte libre n'est masqué que s'il figure parmi
les valeurs `x-personal` connues de l'appel (registre), jamais par motif.
