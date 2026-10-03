-- SPDX-License-Identifier: AGPL-3.0-only
-- 0021_robots_not_read (D-91) : le robots.txt n'est plus lu automatiquement ni contrôlé avant une requête. Migration
-- NON destructive : aucune donnée n'est réécrite ni supprimée.
-- 1. `access_policy.robots` est un champ retiré : la contrainte `apis_access_policy_robots` (0001, durcie par 0015) qui
--    l'exigeait disparaît et la valeur par défaut ne le porte plus. Une politique écrite avant garde sa clé, ignorée à la
--    lecture et à l'écriture (`parseAccessPolicy`).
-- 2. Les classes `robots_disallowed` et `robots_unreachable` ne sont plus produites ; les CHECK de
--    `runs.failure_class` et `run_attempts.result_class` les admettent toujours (valeurs historiques lisibles,
--    `LEGACY_FAILURE_CLASSES`).
-- 3. Politique par défaut `escalade-par-defaut` : version 2, origine seed, sans `robots_disallowed` dans les arrêts,
--    posée seulement si l'admin n'a pas modifié la version 1 (version courante = 1). La version 1 reste dans l'historique
--    immuable : une source qui la cite garde son empreinte vérifiable.
ALTER TABLE apis DROP CONSTRAINT apis_access_policy_robots;
ALTER TABLE apis ALTER COLUMN access_policy
  SET DEFAULT '{"on_ai_signal": "warn", "intended_use": "context", "prefer_official": true, "payment": {"mode": "never"}}';

INSERT INTO rule_file_versions (rule_file_id, version, content, sha256, description, applies_to, author_id, origin, created_at)
SELECT f.id, 2, c.content, encode(sha256(convert_to(c.content, 'UTF8')), 'hex'), v.description, v.applies_to, NULL, 'seed', '2026-10-03T00:00:00Z'
FROM rule_files f
JOIN rule_file_versions v ON v.rule_file_id = f.id AND v.version = 1 AND v.origin = 'seed'
CROSS JOIN (SELECT $seed$---
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

- `blocked_by_protection`, `forbidden` : arrêt de tout essai, statut `bloquee`.
- `auth_required`, `payment_required` : la main revient à l'utilisateur, statut `action_requise`.

## Sélection

La stratégie retenue est la moins chère conforme parmi les couples essayés. Un couple moins cher, ni essayé ni exclu par
une règle, est essayé avant de retenir.
$seed$::text AS content) c
WHERE f.id = '00000000-0000-0000-0000-000000000218' AND f.current_version = 1 AND f.deleted_at IS NULL;

UPDATE rule_files SET current_version = 2, updated_at = '2026-10-03T00:00:00Z'
WHERE id = '00000000-0000-0000-0000-000000000218' AND current_version = 1
  AND EXISTS (SELECT 1 FROM rule_file_versions WHERE rule_file_id = '00000000-0000-0000-0000-000000000218' AND version = 2 AND origin = 'seed');
